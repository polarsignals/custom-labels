export function withLabels<T>(f: () => T, ...kvs: string[]): T;

export function curLabels(): Record<string, string> | undefined;
