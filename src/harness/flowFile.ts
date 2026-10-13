/**
 * Project flows: `<project>/.canvastty/flows/*.json`, `*.yaml` or `*.yml`, written by the person. YAML is read in
 * the small subset a flow needs (mappings, a list of mappings, plain or quoted scalars, `|` blocks); anything else
 * is refused with a message to use JSON. The text is kept as written: it is shown as the person's own.
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

const ID = /^[a-z0-9][a-z0-9_-]{0,39}$/u;
const NAME_PART = /^[A-Za-z0-9._:/-]{1,200}$/u;
const control = /[\u0000-\u0008\u000b-\u001f\u007f]/u;

type Scalar = string;
type Node = Scalar | Node[] | { [key: string]: Node };

function unquote(raw: string, line: number): string {
  const value = raw.trim();
  if (value.startsWith('"')) {
    if (!value.endsWith('"') || value.length < 2) throw new Error(`line ${line}: unclosed quote`);
    return JSON.parse(value) as string;
  }
  if (value.startsWith("'")) {
    if (!value.endsWith("'") || value.length < 2) throw new Error(`line ${line}: unclosed quote`);
    return value.slice(1, -1).replace(/''/gu, "'");
  }
  if (/^[[{&*!%@`]/u.test(value)) throw new Error(`line ${line}: this YAML feature is not supported, use JSON`);
  return value.replace(/\s+#.*$/u, '');
}

/** The YAML subset described above. */
export function parseFlowYaml(text: string): Node {
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

  function mapping(indent: number, first?: { key: string; rest: string }): { [key: string]: Node } {
    const result: { [key: string]: Node } = {};
    const entry = (key: string, rest: string, line: number): void => {
      if (Object.hasOwn(result, key)) throw new Error(`line ${line}: "${key}" twice`);
      if (rest === '|' || rest === '|-' || rest === '>' ) { result[key] = rest === '>' ? block(indent).replace(/\n(?!\n)/gu, ' ') : block(indent); return; }
      if (rest !== '') { result[key] = unquote(rest, line); return; }
      skip();
      const next = lines[index];
      // `key:` with its list at the same indentation ("roles:\n- id: a") is common YAML.
      if (next !== undefined && indentOf(next) === indent && next.trimStart().startsWith('-')) { result[key] = list(indent); return; }
      if (next === undefined || indentOf(next) <= indent) { result[key] = ''; return; }
      result[key] = node(indentOf(next));
    };
    if (first) entry(first.key, first.rest, index);
    for (;;) {
      skip();
      const line = lines[index];
      if (line === undefined || indentOf(line) !== indent || line.trimStart().startsWith('- ')) {
        if (line !== undefined && indentOf(line) > indent) throw new Error(`line ${index + 1}: unexpected indentation`);
        return result;
      }
      const match = /^([A-Za-z_][A-Za-z0-9_-]*):(?:\s+(.*)|\s*)$/u.exec(line.trim());
      if (!match) throw new Error(`line ${index + 1}: expected "key: value"`);
      index++;
      entry(match[1]!, (match[2] ?? '').trim(), index);
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
      if (pair) items.push(mapping(itemIndent, { key: pair[1]!, rest: (pair[2] ?? '').trim() }));
      else items.push(unquote(rest, index));
    }
  }

  function node(indent: number): Node {
    skip();
    const line = lines[index];
    if (line === undefined) return '';
    return line.trimStart().startsWith('-') ? list(indent) : mapping(indent);
  }

  if (text.length > FLOW_LIMITS.fileBytes) throw new Error('the file is too large');
  const result = node(0);
  skip();
  if (index < lines.length) throw new Error(`line ${index + 1}: unexpected text`);
  return result;
}

const str = (value: unknown, max: number, field: string, required = true): string => {
  if (value === undefined && !required) return '';
  if (typeof value !== 'string' || control.test(value) || value.trim() === '' && required || value.length > max) throw new Error(`${field} must be text of at most ${max} characters`);
  return value.trim();
};

/** A flow from a parsed project file; `fileId` is the file name without its extension. */
export function validateFlow(value: unknown, fileId: string, source: FlowDefinition['source'] = 'project'): FlowDefinition {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('a flow is a mapping with name and roles');
  const record = value as Record<string, unknown>;
  const allowed = ['id', 'name', 'description', 'roles'];
  const extra = Object.keys(record).find(key => !allowed.includes(key));
  if (extra) throw new Error(`unknown key "${extra}"`);
  const id = record.id === undefined ? fileId.toLowerCase() : str(record.id, 40, 'id');
  if (!ID.test(id)) throw new Error('id must be lower-case letters, digits, - or _');
  if (!Array.isArray(record.roles) || record.roles.length === 0 || record.roles.length > FLOW_LIMITS.roles) throw new Error(`roles must list 1 to ${FLOW_LIMITS.roles} roles`);
  const ids = new Set<string>();
  const roles = record.roles.map((candidate, position): FlowRole => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) throw new Error(`role ${position + 1} must be a mapping`);
    const role = candidate as Record<string, unknown>;
    const unknown = Object.keys(role).find(key => !['id', 'title', 'task', 'difficulty', 'provider', 'model', 'effort'].includes(key));
    if (unknown) throw new Error(`role ${position + 1}: unknown key "${unknown}"`);
    const roleId = str(role.id, 40, `role ${position + 1} id`);
    if (!ID.test(roleId) || ids.has(roleId)) throw new Error(`role ${position + 1}: id must be unique lower-case letters, digits, - or _`);
    ids.add(roleId);
    const difficulty = role.difficulty === undefined ? 'normal' : role.difficulty;
    if (difficulty !== 'simple' && difficulty !== 'normal' && difficulty !== 'hard') throw new Error(`role ${roleId}: difficulty is simple, normal or hard`);
    const part = (key: 'provider' | 'model' | 'effort'): string | undefined => {
      if (role[key] === undefined || role[key] === '') return undefined;
      const text = str(role[key], 200, `role ${roleId} ${key}`);
      if (!NAME_PART.test(text)) throw new Error(`role ${roleId}: ${key} has characters it cannot have`);
      return text;
    };
    const provider = part('provider'), model = part('model'), effort = part('effort');
    return {
      id: roleId, title: str(role.title ?? roleId, FLOW_LIMITS.title, `role ${roleId} title`), task: str(role.task, FLOW_LIMITS.task, `role ${roleId} task`), difficulty,
      ...(provider ? { provider } : {}), ...(model ? { model } : {}), ...(effort ? { effort } : {})
    };
  });
  return { id, name: str(record.name, FLOW_LIMITS.name, 'name'), description: str(record.description, FLOW_LIMITS.description, 'description', false), source, roles };
}
