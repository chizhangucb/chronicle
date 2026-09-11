// The evaluator behind the workflow-trigger pins: it answers "would this job
// run?" for a real event, instead of pattern-matching the `if:` string.
//
// Why it exists: an `if:` is a program, and the pins that matter here are
// about what it DOES ("a label removal by the factory wakes no sweep"), not
// how it is spelled. A string match cannot tell a reordered clause from a
// deleted one, and it goes green the moment someone rewrites the condition
// into an equivalent shape — which is exactly when a trigger pin should still
// be watching. Feed it the event payload instead and the answer is the one
// GitHub would give.
//
// The subset is what this repo's workflows actually use: string and boolean
// literals, `github.*` / `vars.*` / `needs.*` lookups, `!`, `&&`, `||`, `==`,
// `!=`, parentheses, and the handful of functions below. Anything outside it
// throws rather than guessing, so a future `if:` this cannot read fails the
// pin loudly instead of silently reading as `true`.
//
// Coercion follows GitHub's rule for the one case the workflows lean on: an
// undefined lookup (an unset repository variable, an absent payload field)
// compares equal to the empty string and is falsy.
const FUNCTIONS = {
  startsWith: (value, prefix) => String(value ?? '').startsWith(String(prefix ?? '')),
  endsWith: (value, suffix) => String(value ?? '').endsWith(String(suffix ?? '')),
  contains: (value, item) => String(value ?? '').includes(String(item ?? '')),
  // Status functions: a pin asks whether a condition lets the job run at all,
  // which is the not-cancelled, nothing-failed-yet case.
  cancelled: () => false,
  always: () => true,
  success: () => true,
  failure: () => false,
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
      // GitHub escapes a quote inside a string by doubling it.
      const end = /^'((?:[^']|'')*)'/.exec(rest);
      if (!end) throw new Error(`unterminated string in expression: ${source}`);
      tokens.push({ type: 'string', value: end[1].replace(/''/g, "'") });
      i += end[0].length;
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
    if (token.value === 'null') return null;
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

/**
 * Would a job with this `if:` run, given this context?
 *
 * @param {string|undefined} condition the `if:` as written, `${{ }}` optional
 * @param {object} context `{ github, vars, needs, ... }`, the parts the condition reads
 * @returns {boolean}
 */
export const evaluate = (condition, context) => {
  if (condition === undefined) return true; // no `if:` means the job always runs
  const body = String(condition).trim().replace(/^\$\{\{/, '').replace(/\}\}$/, '');
  return parse(tokenize(body))(context);
};
