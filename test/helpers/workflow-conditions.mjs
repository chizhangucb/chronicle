// The reader behind the workflow-trigger pins (test/ci-triggers.test.mjs,
// test/factory-caller-wakeups.test.mjs): it answers "which jobs would this
// event start?" by evaluating the real `if:` conditions, instead of
// pattern-matching their text.
//
// Why it exists: an `if:` is a program, and the pins that matter are about what
// it DOES ("a label removal by the factory wakes no sweep"), not how it is
// spelled. A string match cannot tell a reordered clause from a deleted one,
// and it goes green the moment someone rewrites the condition into an
// equivalent shape, which is exactly when a trigger pin should still be
// watching. Feed it the event payload instead and the answer is the one GitHub
// would give. Shared by both pins for the reason test/helpers/tracked-files.mjs
// gives: two copies of one sweep drifted apart once already (issue #186).
//
// The subset is what this repo's two workflows use in an `if:`: string and
// boolean literals, `github.*` / `vars.*` / `needs.*` lookups, `!`, `&&`, `||`,
// `==`, `!=`, parentheses, `startsWith()` and `cancelled()`. Anything outside
// it throws rather than guessing, so an `if:` this cannot read fails the pin
// loudly instead of silently reading as `true`, and the day a workflow needs
// another function is the day it is added here.
//
// Coercion follows GitHub's rule for the one case the workflows lean on: an
// undefined lookup (an unset repository variable, an absent payload field)
// compares equal to the empty string and is falsy.
import yaml from 'js-yaml';
import { read } from './tracked-files.mjs';

const FUNCTIONS = {
  startsWith: (value, prefix) => String(value ?? '').startsWith(String(prefix ?? '')),
  // A pin asks whether a condition lets the job run at all, which is the
  // not-cancelled case.
  cancelled: () => false,
};

const tokenize = (source) => {
  const tokens = [];
  let i = 0;
  while (i < source.length) {
    const rest = source.slice(i);
    const ws = /^\s+/.exec(rest);
    if (ws) {
      i += ws[0].length;
      continue;
    }
    const operator = /^(&&|\|\||==|!=|!|\(|\)|,)/.exec(rest);
    if (operator) {
      tokens.push({ type: 'op', value: operator[0] });
      i += operator[0].length;
      continue;
    }
    if (rest[0] === "'") {
      const string = /^'([^']*)'/.exec(rest);
      if (!string) throw new Error(`unterminated string in expression: ${source}`);
      tokens.push({ type: 'string', value: string[1] });
      i += string[0].length;
      continue;
    }
    const word = /^[A-Za-z_][A-Za-z0-9_.-]*/.exec(rest);
    if (word) {
      tokens.push({ type: 'word', value: word[0] });
      i += word[0].length;
      continue;
    }
    throw new Error(`cannot read expression at "${rest.slice(0, 20)}": ${source}`);
  }
  return tokens;
};

/** `github.event.label.name` against the context object, undefined where it stops. */
const lookup = (path, context) =>
  path.split('.').reduce((value, key) => (value === null || value === undefined ? undefined : value[key]), context);

const truthy = (value) => !(value === undefined || value === null || value === false || value === '' || value === 0);

/** GitHub compares an absent value equal to the empty string, so unset means empty. */
const equal = (left, right) => (left ?? '') === (right ?? '');

const parse = (tokens) => {
  let at = 0;
  const peek = () => tokens[at];
  const eat = (value) => {
    if (peek()?.value !== value) throw new Error(`expected ${value}, got ${peek()?.value ?? 'end of expression'}`);
    at += 1;
  };

  const primary = (context) => {
    const token = peek();
    if (!token) throw new Error('expression ends early');
    if (token.value === '(') {
      eat('(');
      const value = or(context);
      eat(')');
      return value;
    }
    at += 1;
    if (token.type === 'string') return token.value;
    if (token.value === 'true') return true;
    if (token.value === 'false') return false;
    if (peek()?.value === '(') {
      const fn = FUNCTIONS[token.value];
      if (!fn) throw new Error(`unknown function in expression: ${token.value}()`);
      eat('(');
      const args = [];
      while (peek()?.value !== ')') {
        args.push(or(context));
        if (peek()?.value === ',') eat(',');
      }
      eat(')');
      return fn(...args);
    }
    return lookup(token.value, context);
  };

  const unary = (context) => {
    if (peek()?.value === '!') {
      eat('!');
      return !truthy(unary(context));
    }
    return primary(context);
  };

  const comparison = (context) => {
    const left = unary(context);
    const operator = peek()?.value;
    if (operator !== '==' && operator !== '!=') return left;
    eat(operator);
    const right = unary(context);
    return operator === '==' ? equal(left, right) : !equal(left, right);
  };

  const and = (context) => {
    let value = comparison(context);
    while (peek()?.value === '&&') {
      eat('&&');
      const right = comparison(context);
      value = truthy(value) ? right : value;
    }
    return value;
  };

  const or = (context) => {
    let value = and(context);
    while (peek()?.value === '||') {
      eat('||');
      const right = and(context);
      value = truthy(value) ? value : right;
    }
    return value;
  };

  return (context) => {
    at = 0;
    const value = or(context);
    if (at !== tokens.length) throw new Error(`trailing input in expression: ${tokens[at].value}`);
    return truthy(value);
  };
};

/** Would a job with this `if:` run, given this context? No `if:` means it always runs. */
const evaluate = (condition, context) => {
  if (condition === undefined) return true;
  const body = String(condition).trim().replace(/^\$\{\{/, '').replace(/\}\}$/, '');
  return parse(tokenize(body))(context);
};

/**
 * A workflow file, read the way GitHub reads it.
 *
 * @param {string} rel path from the repo root
 * @returns {{ doc: object, triggers: object, jobsFor: (context: object) => string[] }}
 *   `triggers` is the `on:` block, `jobsFor` the job ids a run would start for
 *   a context of `{ github, vars, needs }`.
 */
export const workflow = (rel) => {
  const doc = yaml.load(read(rel));
  return {
    doc,
    // `on:` parses to YAML 1.1's boolean true, which is why GitHub's own docs
    // quote it. Read it either way rather than depending on the spelling.
    triggers: doc.on ?? doc[true],
    jobsFor: (context) =>
      Object.entries(doc.jobs)
        .filter(([, job]) => evaluate(job.if, context))
        .map(([id]) => id),
  };
};
