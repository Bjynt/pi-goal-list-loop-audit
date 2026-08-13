export declare function quoteWindowsCommandArgument(value: unknown): string;

export declare function buildAuditorPiSpawnSpec(
  piBinary: string,
  piArgs: readonly string[],
  platform?: string,
  comspec?: string,
): {
  file: string;
  args: string[];
  options: Record<string, unknown>;
};

export declare function renameWithWindowsRetry(
  renameFn: (temp: string, file: string) => Promise<void>,
  temp: string,
  file: string,
  platform?: string,
  sleep?: (milliseconds: number) => Promise<void>,
): Promise<void>;
