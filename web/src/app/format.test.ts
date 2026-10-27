import { describe, expect, it } from 'vitest';
import { resultText } from './format';

describe('format', () => {
  it('says who won a settled market, or that it split', () => {
    expect(resultText(['Yes', 'No'], { den: 1, num: [1, 0] })).toBe('YES won');
    expect(resultText(['Navi', 'FaZe'], { den: 1, num: [0, 1] })).toBe('FAZE won');
    expect(resultText(['Yes', 'No'], { den: 2, num: [1, 1] })).toBe('50-50: each share paid half');
  });
});
