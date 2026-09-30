import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { AuditAction, ContactMessageStatus, Prisma } from '@prisma/client';
import { TooManyRequestsException } from '../../common/exceptions/too-many-requests.exception';
import type { RequestContext } from '../../common/types/request-context';
import { toE164, toNationalFormat } from '../../common/validators/iranian-mobile';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { RedisService } from '../../infra/redis/redis.service';
import {
  cleanText,
  CONTACT_LIMITS,
  CONTACT_MAX_PER_IP_PER_HOUR,
  CONTACT_MAX_PER_MOBILE_PER_HOUR,
  CONTACT_WINDOW_SECONDS,
  contactIpKey,
  contactMobileKey,
  stripFormulaPrefix,
} from './contact-rules';
import type {
  AdminContactMessageDto,
  AdminContactMessagePageDto,
  ContactMessageQueryDto,
  ContactMessageReceiptDto,
  CreateContactMessageDto,
  UpdateContactMessageDto,
} from './dto/contact-message.dto';

const ACTOR = { select: { id: true, fullName: true } } as const;
const ADMIN_SELECT = {
  id: true,
  fullName: true,
  mobile: true,
  email: true,
  topic: true,
  subject: true,
  message: true,
  status: true,
  staffNote: true,
  handledAt: true,
  createdAt: true,
  updatedAt: true,
  user: ACTOR,
  handledBy: ACTOR,
} satisfies Prisma.ContactMessageSelect;

type AdminRow = Prisma.ContactMessageGetPayload<{ select: typeof ADMIN_SELECT }>;

function badRequest(code: string, message: string): BadRequestException {
  return new BadRequestException({ statusCode: 400, error: 'Bad Request', code, message });
}

/** Short reference customers can quote on the phone: first 8 hex chars of the id. */
export function contactReference(id: string): string {
  return `C-${id.replace(/-/g, '').slice(0, 8).toUpperCase()}`;
}

@Injectable()
export class SupportService {
  private readonly logger = new Logger(SupportService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  async submit(dto: CreateContactMessageDto, params: { userId: string | null; context: RequestContext }): Promise<ContactMessageReceiptDto> {
    if (dto.website !== undefined && dto.website.trim() !== '') {
      // Honeypot filled → a bot. Same 400 as any invalid form; nothing stored.
      this.logger.warn(`Contact form honeypot triggered from ${params.context.ipAddress ?? 'unknown ip'}`);
      throw badRequest('CONTACT_REJECTED', 'The message could not be accepted');
    }
    const mobile = toE164(dto.mobile);
    if (mobile === null) throw badRequest('CONTACT_INVALID_MOBILE', 'mobile must be an Iranian mobile number');

    const fullName = stripFormulaPrefix(cleanText(dto.fullName, false));
    const subject = stripFormulaPrefix(cleanText(dto.subject, false));
    const message = cleanText(dto.message, true);
    const email = dto.email?.trim() ? dto.email.trim().toLowerCase() : null;
    if (fullName.length < CONTACT_LIMITS.fullName.min) throw badRequest('CONTACT_INVALID_FIELD', 'fullName is too short');
    if (subject.length < CONTACT_LIMITS.subject.min) throw badRequest('CONTACT_INVALID_FIELD', 'subject is too short');
    if (message.length < CONTACT_LIMITS.message.min) throw badRequest('CONTACT_INVALID_FIELD', 'message is too short');

    await this.enforceLimit(params.context.ipAddress ? contactIpKey(params.context.ipAddress) : null, CONTACT_MAX_PER_IP_PER_HOUR);
    await this.enforceLimit(contactMobileKey(mobile), CONTACT_MAX_PER_MOBILE_PER_HOUR);

    const row = await this.prisma.contactMessage.create({
      data: {
        fullName,
        mobile,
        email,
        topic: dto.topic,
        subject,
        message,
        userId: params.userId,
        ipAddress: params.context.ipAddress?.slice(0, 45) ?? null,
        userAgent: params.context.userAgent?.slice(0, 255) ?? null,
      },
      select: { id: true, createdAt: true },
    });
    this.logger.log(`Contact message ${row.id} received (topic ${dto.topic})`);
    return { id: row.id, reference: contactReference(row.id), createdAt: row.createdAt.toISOString() };
  }

  async list(query: ContactMessageQueryDto): Promise<AdminContactMessagePageDto> {
    const where: Prisma.ContactMessageWhereInput = { status: query.status, topic: query.topic };
    const [rows, total, grouped] = await Promise.all([
      this.prisma.contactMessage.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (query.page - 1) * query.pageSize, take: query.pageSize, select: ADMIN_SELECT }),
      this.prisma.contactMessage.count({ where }),
      this.prisma.contactMessage.groupBy({ by: ['status'], _count: { _all: true } }),
    ]);
    const counts = { NEW: 0, IN_PROGRESS: 0, RESOLVED: 0 } as Record<ContactMessageStatus, number>;
    for (const group of grouped) counts[group.status] = group._count._all;
    return { items: rows.map(toAdmin), page: query.page, pageSize: query.pageSize, total, totalPages: Math.ceil(total / query.pageSize), counts };
  }

  async update(id: string, dto: UpdateContactMessageDto, params: { actorId: string; context: RequestContext }): Promise<AdminContactMessageDto> {
    if (dto.status === undefined && dto.staffNote === undefined) throw badRequest('CONTACT_NOTHING_TO_UPDATE', 'Send status and/or staffNote');
    const current = await this.prisma.contactMessage.findUnique({ where: { id }, select: { status: true, staffNote: true } });
    if (!current) throw new NotFoundException({ statusCode: 404, error: 'Not Found', code: 'CONTACT_MESSAGE_NOT_FOUND', message: 'Contact message not found' });

    const staffNote = dto.staffNote === undefined ? current.staffNote : dto.staffNote === null ? null : cleanText(dto.staffNote, true) || null;
    const status = dto.status ?? current.status;
    const row = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.contactMessage.update({
        where: { id },
        data: { status, staffNote, handledByUserId: params.actorId, handledAt: new Date() },
        select: ADMIN_SELECT,
      });
      await tx.auditLog.create({
        data: {
          userId: params.actorId,
          action: status !== current.status ? AuditAction.STATUS_CHANGE : AuditAction.UPDATE,
          entityName: 'ContactMessage',
          entityId: id,
          ipAddress: params.context.ipAddress,
          userAgent: params.context.userAgent,
          oldValue: { status: current.status, staffNoteSet: current.staffNote !== null },
          newValue: { status, staffNoteSet: staffNote !== null },
        },
      });
      return updated;
    });
    return toAdmin(row);
  }

  private async enforceLimit(key: string | null, max: number): Promise<void> {
    if (key === null) return;
    const count = await this.redis.client.incr(key);
    if (count === 1) await this.redis.client.expire(key, CONTACT_WINDOW_SECONDS);
    if (count > max) {
      const ttl = await this.redis.client.ttl(key);
      throw new TooManyRequestsException('Too many messages; please try again later', ttl > 0 ? ttl : CONTACT_WINDOW_SECONDS);
    }
  }
}

function toAdmin(row: AdminRow): AdminContactMessageDto {
  return {
    id: row.id,
    reference: contactReference(row.id),
    fullName: row.fullName,
    mobile: toNationalFormat(row.mobile),
    email: row.email,
    topic: row.topic,
    subject: row.subject,
    message: row.message,
    status: row.status,
    staffNote: row.staffNote,
    sender: row.user,
    handledBy: row.handledBy,
    handledAt: row.handledAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
