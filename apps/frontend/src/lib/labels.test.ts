import { describe, expect, it } from 'vitest';

import { CREDIT_DECISION_REASON, creditDecisionReason } from './labels';

describe('creditDecisionReason', () => {
  it('maps every provider decision code the backend emits to Persian', () => {
    for (const code of ['SCORE_BELOW_THRESHOLD', 'NOT_ELIGIBLE', 'BELOW_MINIMUM_LIMIT', 'CAPPED_AT_MAXIMUM']) {
      expect(CREDIT_DECISION_REASON[code]).toBeDefined();
      expect(creditDecisionReason(code)).toMatch(/[\u0600-\u06FF]/);
    }
  });

  it('never shows a raw code for unknown reasons', () => {
    const text = creditDecisionReason('SOME_FUTURE_CODE');
    expect(text).not.toContain('SOME_FUTURE_CODE');
    expect(text).toMatch(/[\u0600-\u06FF]/);
  });
});
