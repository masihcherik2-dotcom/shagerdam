import type { ProductSpecification } from '@/lib/api/types';
import { groupSpecifications } from '@/lib/product-specs';

/** Storefront specification table, grouped the way the vendor ordered it. */
export function ProductSpecifications({ specifications }: { specifications: ProductSpecification[] }) {
  if (specifications.length === 0) return null;
  const groups = groupSpecifications(specifications);
  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-6" aria-labelledby="product-specs-title">
      <h2 id="product-specs-title" className="mb-4 text-lg font-bold text-slate-900">
        مشخصات فنی
      </h2>
      <div className="flex flex-col gap-6">
        {groups.map((group, index) => (
          <div key={`${group.groupTitle ?? ''}-${index}`} className="grid gap-3 md:grid-cols-[10rem_1fr]">
            <h3 className="text-sm font-bold text-slate-800">{group.groupTitle ?? ''}</h3>
            <dl className="divide-y divide-slate-100">
              {group.items.map((item, itemIndex) => (
                <div key={`${item.title}-${itemIndex}`} className="grid gap-1 py-2.5 text-sm sm:grid-cols-[12rem_1fr] sm:gap-4">
                  <dt className="text-slate-500">{item.title}</dt>
                  <dd className="whitespace-pre-line leading-7 text-slate-800">{item.value}</dd>
                </div>
              ))}
            </dl>
          </div>
        ))}
      </div>
    </section>
  );
}
