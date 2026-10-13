/**
 * Project flows: `<project>/.canvastty/flows/*.json`, `*.yaml` or `*.yml`, written by the person. YAML is read in
 * the small subset a flow needs (mappings, a list of mappings, plain or quoted scalars, `|` blocks); anything else
 * is refused with a message to use JSON. The text is kept as written, without invisible characters (controls, bidi
 * and zero-width marks), so the preview shows exactly what a subagent would get. A refused file is reported with a
 * fixed reason (a code, localized where it is shown), never with the parser's own message: that could quote the file.
 */
export interface FlowRole {
  id: string;
  title: string;
  /** The role's task; `{goal}` becomes the goal the orchestrator or the person gives. */
  task: string;
  difficulty: 'simple' | 'normal' | 'hard';
  provider?: string;
  model?: string;
  effort?: string;
}

export interface FlowDefinition {
  id: string;
  name: string;
  description: string;
  source: 'built-in' | 'project';
  roles: FlowRole[];
}

export const FLOW_LIMITS = Object.freeze({ files: 32, fileBytes: 32_768, roles: 8, name: 80, description: 400, task: 2_000, title: 60 });

/** Why a project flow file was not loaded. Shown through a fixed, localized sentence; nothing from the file. */
export type FlowProblemCode =
  | 'link' | 'folderLink' | 'outside' | 'tooLarge' | 'unreadable' | 'json' | 'yaml' | 'yamlUnsupported'
  | 'reservedKey' | 'shape' | 'unknownKey' | 'field' | 'duplicate';
export type FlowField = 'name' | 'description' | 'id' | 'roles' | 'role' | 'title' | 'task' | 'difficulty' | 'provider' | 'model' | 'effort';
export interface FlowProblem { code: FlowProblemCode; line?: number; field?: FlowField; role?: number }

export class FlowFileError extends Error {
  readonly problem: FlowProblem;
  constructor(problem: FlowProblem) {
    super(`flow file: ${problem.code}`);
    this.problem = problem;
  }
}

const fail = (problem: FlowProblem): never => { throw new FlowFileError(problem); };

/** Keys that would reach an object's prototype; refused anywhere in a flow (and in the plugin's own files). */
export const RESERVED_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Text as the person wrote it, without what a reader cannot see: C0/C1 controls (a tab becomes a space; new lines
 * stay where `multiline`), Unicode format characters (bidi overrides and isolates, zero-width marks, BOM, soft
 * hyphen) and line/paragraph separators.
 */
export function visibleText(value: string, multiline = false): string {
  const text = value.replace(/\r\n?|[\u2028\u2029]/gu, '\n').replace(/\t/gu, ' ').replace(/(?!\n)[\p{Cc}\p{Cf}]/gu, '');
  return multiline ? text : text.replace(/\n+/gu, ' ');
}

const ID = /^[a-z0-9][a-z0-9_-]{0,39}$/u;
const NAME_PART = /^[A-Za-z0-9._:/-]{1,200}$/u;

type Scalar = string;
type Node = Scalar | Node[] | { [key: string]: Node };

function unquote(raw: string, line: number): string {
  const value = raw.trim();
  if (value.startsWith('"')) {
    if (!value.endsWith('"') || value.length < 2) fail({ code: 'yaml', line });
    try { return JSON.parse(value) as string; } catch { return fail({ code: 'yaml', line }); }
  }
  if (value.startsWith("'")) {
    if (!value.endsWith("'") || value.length < 2) fail({ code: 'yaml', line });
    return value.slice(1, -1).replace(/''/gu, "'");
  }
  if (/^[[{&*!%@`]/u.test(value)) fail({ code: 'yamlUnsupported', line });
  return value.replace(/\s+#.*$/u, '');
}

/** The YAML subset described above. Mappings have no prototype, and a reserved key is refused. */
export function parseFlowYaml(text: string): Node {
  if (text.length > FLOW_LIMITS.fileBytes) fail({ code: 'tooLarge' });
  const lines = text.replace(/\r\n?/gu, '\n').split('\n');
  let index = 0;
  const indentOf = (line: string): number => line.length - line.trimStart().length;
  const skip = (): void => { while (index < lines.length && (/^\s*(#.*)?$/u.test(lines[index]!))) index++; };

  function block(indent: number): string {
    const out: string[] = [];
    let base = -1;
    while (index < lines.length) {
      const line = lines[index]!;
      if (line.trim() === '') { out.push(''); index++; continue; }
      const own = indentOf(line);
      if (own <= indent) break;
      if (base < 0) base = own;
      out.push(line.slice(Math.min(base, own)));
      index++;
    }
    return out.join('\n').replace(/\n+$/u, '');
  }

  function mapping(indent: number, first?: { key: string; rest: string; line: number }): { [key: string]: Node } {
    const result = Object.create(null) as { [key: string]: Node };
    const entry = (key: string, rest: string, line: number): void => {
      if (RESERVED_KEYS.has(key)) fail({ code: 'reservedKey', line });
      if (Object.hasOwn(result, key)) fail({ code: 'yaml', line });
      if (rest === '|' || rest === '|-' || rest === '>') { result[key] = rest === '>' ? block(indent).replace(/\n(?!\n)/gu, ' ') : block(indent); return; }
      if (rest !== '') { result[key] = unquote(rest, line); return; }
      skip();
      const next = lines[index];
      // `key:` with its list at the same indentation ("roles:\n- id: a") is common YAML.
      if (next !== undefined && indentOf(next) === indent && next.trimStart().startsWith('-')) { result[key] = list(indent); return; }
      if (next === undefined || indentOf(next) <= indent) { result[key] = ''; return; }
      result[key] = node(indentOf(next));
    };
    if (first) entry(first.key, first.rest, first.line);
    for (;;) {
      skip();
      const line = lines[index];
      if (line === undefined || indentOf(line) !== indent || line.trimStart().startsWith('- ')) {
        if (line !== undefined && indentOf(line) > indent) fail({ code: 'yaml', line: index + 1 });
        return result;
      }
      const match = /^([A-Za-z_][A-Za-z0-9_-]*):(?:\s+(.*)|\s*)$/u.exec(line.trim());
      if (!match) fail({ code: 'yaml', line: index + 1 });
      index++;
      entry(match![1]!, (match![2] ?? '').trim(), index);
    }
  }

  function list(indent: number): Node[] {
    const items: Node[] = [];
    for (;;) {
      skip();
      const line = lines[index];
      if (line === undefined || indentOf(line) !== indent || !line.trimStart().startsWith('-')) return items;
      const rest = line.trimStart().slice(1).trim();
      index++;
      const pair = /^([A-Za-z_][A-Za-z0-9_-]*):(?:\s+(.*)|\s*)$/u.exec(rest);
      // The item's further keys line up with its first key, after "- ".
      const itemIndent = indent + (line.trimStart().length - rest.length);
      if (pair) items.push(mapping(itemIndent, { key: pair[1]!, rest: (pair[2] ?? '').trim(), line: index }));
      else items.push(unquote(rest, index));
    }
  }

  function node(indent: number): Node {
    skip();
    const line = lines[index];
    if (line === undefined) return '';
    return line.trimStart().startsWith('-') ? list(indent) : mapping(indent);
  }

  const result = node(0);
  skip();
  if (index < lines.length) fail({ code: 'yaml', line: index + 1 });
  return result;
}

/** A JSON flow file: a reserved key anywhere is refused; a syntax error names its line only. */
export function parseFlowJson(text: string): unknown {
  if (text.length > FLOW_LIMITS.fileBytes) fail({ code: 'tooLarge' });
  try {
    return JSON.parse(text, (key, value: unknown) => { if (RESERVED_KEYS.has(key)) fail({ code: 'reservedKey' }); return value; }) as unknown;
  } catch (error) {
    if (error instanceof FlowFileError) throw error;
    const message = error instanceof Error ? error.message : '';
    const line = /\bline (\d+)/u.exec(message)?.[1];
    const position = /\bposition (\d+)/u.exec(message)?.[1];
    const at = line ? Number(line) : position ? text.slice(0, Number(position)).split('\n').length : undefined;
    return fail({ code: 'json', ...(at && Number.isSafeInteger(at) ? { line: at } : {}) });
  }
}

const str = (value: unknown, max: number, problem: Omit<FlowProblem, 'code'>, options: { required?: boolean; multiline?: boolean } = {}): string => {
  const required = options.required ?? true;
  if (value === undefined && !required) return '';
  if (typeof value !== 'string') return fail({ code: 'field', ...problem });
  const text = visibleText(value, options.multiline).trim();
  if ((text === '' && required) || text.length > max) fail({ code: 'field', ...problem });
  return text;
};

/** A flow from a parsed project file; `fileId` is the file name without its extension. */
export function validateFlow(value: unknown, fileId: string, source: FlowDefinition['source'] = 'project'): FlowDefinition {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail({ code: 'shape' });
  const record = value as Record<string, unknown>;
  const allowed = ['id', 'name', 'description', 'roles'];
  if (Object.keys(record).some(key => RESERVED_KEYS.has(key))) fail({ code: 'reservedKey' });
  if (Object.keys(record).some(key => !allowed.includes(key))) fail({ code: 'unknownKey' });
  const id = record.id === undefined ? fileId.toLowerCase() : str(record.id, 40, { field: 'id' });
  if (!ID.test(id)) fail({ code: 'field', field: 'id' });
  if (!Array.isArray(record.roles) || record.roles.length === 0 || record.roles.length > FLOW_LIMITS.roles) fail({ code: 'field', field: 'roles' });
  const ids = new Set<string>();
  const roles = (record.roles as unknown[]).map((candidate, position): FlowRole => {
    const at = position + 1;
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) fail({ code: 'field', field: 'role', role: at });
    const role = candidate as Record<string, unknown>;
    if (Object.keys(role).some(key => RESERVED_KEYS.has(key))) fail({ code: 'reservedKey', role: at });
    if (Object.keys(role).some(key => !['id', 'title', 'task', 'difficulty', 'provider', 'model', 'effort'].includes(key))) fail({ code: 'unknownKey', role: at });
    const roleId = str(role.id, 40, { field: 'id', role: at });
    if (!ID.test(roleId) || ids.has(roleId)) fail({ code: 'field', field: 'id', role: at });
    ids.add(roleId);
    const difficulty = role.difficulty === undefined ? 'normal' : role.difficulty;
    if (difficulty !== 'simple' && difficulty !== 'normal' && difficulty !== 'hard') return fail({ code: 'field', field: 'difficulty', role: at });
    const part = (key: 'provider' | 'model' | 'effort'): string | undefined => {
      if (role[key] === undefined || role[key] === '') return undefined;
      const text = str(role[key], 200, { field: key, role: at });
      if (!NAME_PART.test(text)) fail({ code: 'field', field: key, role: at });
      return text;
    };
    const provider = part('provider'), model = part('model'), effort = part('effort');
    return {
      id: roleId, title: str(role.title ?? roleId, FLOW_LIMITS.title, { field: 'title', role: at }),
      task: str(role.task, FLOW_LIMITS.task, { field: 'task', role: at }, { multiline: true }), difficulty,
      ...(provider ? { provider } : {}), ...(model ? { model } : {}), ...(effort ? { effort } : {})
    };
  });
  return {
    id, name: str(record.name, FLOW_LIMITS.name, { field: 'name' }),
    description: str(record.description, FLOW_LIMITS.description, { field: 'description' }, { required: false, multiline: true }), source, roles
  };
}
