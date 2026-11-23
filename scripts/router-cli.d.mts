export function routerCli(
  table: { router?: { command?: string; model?: string } | string; routers?: Record<string, { command?: string; model?: string }> } | undefined,
  command?: string,
  model?: string,
): { command: string; model?: string } | undefined
export function defaultHarnessFile(stateDir?: string, exists?: (file: string) => boolean): string | undefined
