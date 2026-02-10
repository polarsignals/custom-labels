export type LabelValue = string | boolean | number | null | undefined;

export function withLabels<T>(f: () => T, ...kvs: LabelValue[]): T;

export function curLabels(): Record<string, string> | undefined;
