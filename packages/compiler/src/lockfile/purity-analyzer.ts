/**
 * AST-based purity analysis for dynamic job functions.
 * Determines whether a function can be safely evaluated inline by the orchestrator
 * (via vm.runInNewContext) without requiring a full init job dispatch.
 *
 * A function is "pure" if it:
 * - Is synchronous (not async)
 * - Only references its parameters and safe globals
 * - Does not perform I/O, mutation, or use external scope
 * - Only uses const/let for local declarations (no var)
 */

import ts from 'typescript';

/** Result of purity analysis */
interface PurityResult {
  pure: boolean;
  reason?: string;
}

/**
 * Safe globals that pure functions are allowed to reference.
 * These are deterministic, side-effect-free built-ins.
 */
const SAFE_GLOBALS = new Set([
  'undefined',
  'null',
  'true',
  'false',
  'NaN',
  'Infinity',
  'String',
  'Number',
  'Boolean',
  'Array',
  'Object',
  'JSON',
  'Math',
  'parseInt',
  'parseFloat',
  'isNaN',
  'isFinite',
  'encodeURIComponent',
  'decodeURIComponent',
  'encodeURI',
  'decodeURI',
]);

/**
 * Assignment operators that indicate mutation.
 */
const ASSIGNMENT_OPERATORS = new Set([
  ts.SyntaxKind.EqualsToken,
  ts.SyntaxKind.PlusEqualsToken,
  ts.SyntaxKind.MinusEqualsToken,
  ts.SyntaxKind.AsteriskEqualsToken,
  ts.SyntaxKind.SlashEqualsToken,
  ts.SyntaxKind.PercentEqualsToken,
  ts.SyntaxKind.AmpersandEqualsToken,
  ts.SyntaxKind.BarEqualsToken,
  ts.SyntaxKind.CaretEqualsToken,
  ts.SyntaxKind.LessThanLessThanEqualsToken,
  ts.SyntaxKind.GreaterThanGreaterThanEqualsToken,
  ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken,
  ts.SyntaxKind.AsteriskAsteriskEqualsToken,
  ts.SyntaxKind.BarBarEqualsToken,
  ts.SyntaxKind.AmpersandAmpersandEqualsToken,
  ts.SyntaxKind.QuestionQuestionEqualsToken,
]);

/**
 * Analyze whether a function source string represents a pure function.
 *
 * @param fnSource - The function source code (e.g., "(event) => event.ref")
 * @returns PurityResult indicating whether the function is pure
 */
export function analyzePurity(fnSource: string): PurityResult {
  // Wrap function source as a variable declaration so TS can parse it
  const wrapped = 'const __fn = ' + fnSource;
  const sourceFile = ts.createSourceFile(
    'inline.js',
    wrapped,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );

  // Extract the function node from the variable declaration
  const firstStatement = sourceFile.statements[0];
  if (!ts.isVariableStatement(firstStatement)) {
    return { pure: false, reason: 'failed to parse function source' };
  }

  const declaration = firstStatement.declarationList.declarations[0];
  if (!declaration.initializer) {
    return { pure: false, reason: 'failed to parse function source' };
  }

  const fnNode = declaration.initializer;

  // Must be an arrow function or function expression
  if (!ts.isArrowFunction(fnNode) && !ts.isFunctionExpression(fnNode)) {
    return { pure: false, reason: 'not a function expression' };
  }

  // Check for async modifier
  const modifiers = ts.getModifiers(fnNode);
  if (modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)) {
    return { pure: false, reason: 'async functions cannot be inlined' };
  }

  // Check for generator
  if (ts.isFunctionExpression(fnNode) && fnNode.asteriskToken) {
    return { pure: false, reason: 'generator functions cannot be inlined' };
  }

  // Collect parameter names (including destructured bindings)
  const paramNames = new Set<string>();
  for (const param of fnNode.parameters) {
    collectBindingNames(param.name, paramNames);
  }

  // Track local variable declarations
  const localNames = new Set<string>();

  // Walk the function body
  const result = checkNode(fnNode.body, paramNames, localNames);
  return result ?? { pure: true };
}

/**
 * Recursively collect binding names from parameter declarations,
 * including destructured patterns.
 */
function collectBindingNames(node: ts.BindingName, names: Set<string>): void {
  if (ts.isIdentifier(node)) {
    names.add(node.text);
  } else if (ts.isObjectBindingPattern(node)) {
    for (const element of node.elements) {
      collectBindingNames(element.name, names);
    }
  } else if (ts.isArrayBindingPattern(node)) {
    for (const element of node.elements) {
      if (!ts.isOmittedExpression(element)) {
        collectBindingNames(element.name, names);
      }
    }
  }
}

/**
 * Check a node and its children for impurity.
 * Returns a PurityResult if impure, or undefined if pure so far.
 */
function checkNode(
  node: ts.Node,
  paramNames: Set<string>,
  localNames: Set<string>,
): PurityResult | undefined {
  // Rejected node types
  switch (node.kind) {
    case ts.SyntaxKind.AwaitExpression:
      return { pure: false, reason: 'contains await expression' };
    case ts.SyntaxKind.ImportDeclaration:
      return { pure: false, reason: 'contains import declaration' };
    case ts.SyntaxKind.YieldExpression:
      return { pure: false, reason: 'contains yield expression' };
    case ts.SyntaxKind.ClassDeclaration:
    case ts.SyntaxKind.ClassExpression:
      return { pure: false, reason: 'contains class declaration' };
    case ts.SyntaxKind.ThisKeyword:
      return { pure: false, reason: "references 'this'" };
    case ts.SyntaxKind.DeleteExpression:
      return { pure: false, reason: "contains 'delete' expression" };
    case ts.SyntaxKind.ThrowStatement:
      return { pure: false, reason: 'contains throw statement' };
    case ts.SyntaxKind.TryStatement:
      return { pure: false, reason: 'contains try/catch' };
  }

  // NewExpression check
  if (ts.isNewExpression(node)) {
    return { pure: false, reason: "contains 'new' expression" };
  }

  // Dynamic import: import('...')
  if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
    return { pure: false, reason: 'contains dynamic import' };
  }

  // require() call check
  if (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === 'require'
  ) {
    return { pure: false, reason: 'contains require() call' };
  }

  // Postfix/prefix ++ and --
  if (ts.isPostfixUnaryExpression(node)) {
    if (
      node.operator === ts.SyntaxKind.PlusPlusToken ||
      node.operator === ts.SyntaxKind.MinusMinusToken
    ) {
      return { pure: false, reason: 'contains mutation operator' };
    }
  }
  if (ts.isPrefixUnaryExpression(node)) {
    if (
      node.operator === ts.SyntaxKind.PlusPlusToken ||
      node.operator === ts.SyntaxKind.MinusMinusToken
    ) {
      return { pure: false, reason: 'contains mutation operator' };
    }
  }

  // Assignment operators in binary expressions
  if (ts.isBinaryExpression(node) && ASSIGNMENT_OPERATORS.has(node.operatorToken.kind)) {
    return { pure: false, reason: 'contains assignment' };
  }

  // Variable declarations: only const and let are allowed
  if (ts.isVariableDeclarationList(node)) {
    if (node.flags & ts.NodeFlags.Const || node.flags & ts.NodeFlags.Let) {
      // Allowed -- collect names
      for (const decl of node.declarations) {
        collectBindingNames(decl.name, localNames);
      }
    } else {
      // var declaration
      return { pure: false, reason: "'var' declarations are not allowed (use const or let)" };
    }
    // Still need to check initializers
  }

  // Identifier check -- only for standalone identifiers, not property access RHS
  if (ts.isIdentifier(node)) {
    const parent = node.parent;

    // Skip identifiers that are:
    // (a) right side of property access (e.g., event.ref -- 'ref' is fine)
    if (ts.isPropertyAccessExpression(parent) && parent.name === node) {
      // This is the property name, not a free variable -- skip
    }
    // (b) property name in object literal (e.g., { key: value } -- 'key' is fine)
    else if (ts.isPropertyAssignment(parent) && parent.name === node) {
      // Property name -- skip
    }
    // (c) shorthand property assignment (e.g., { ref } -- ref is both name and value)
    else if (ts.isShorthandPropertyAssignment(parent) && parent.name === node) {
      // The name itself is also the value -- check if it's allowed
      if (
        !paramNames.has(node.text) &&
        !localNames.has(node.text) &&
        !SAFE_GLOBALS.has(node.text)
      ) {
        return { pure: false, reason: `references unknown identifier '${node.text}'` };
      }
    }
    // (d) variable declaration name
    else if (ts.isVariableDeclaration(parent) && parent.name === node) {
      // Declaration name -- skip
    }
    // (e) binding element name in destructuring
    else if (ts.isBindingElement(parent) && parent.name === node) {
      // Destructured name -- skip
    }
    // (f) parameter declaration name
    else if (ts.isParameter(parent) && parent.name === node) {
      // Parameter name -- skip
    }
    // Otherwise, check if it's allowed
    else if (
      !paramNames.has(node.text) &&
      !localNames.has(node.text) &&
      !SAFE_GLOBALS.has(node.text)
    ) {
      return { pure: false, reason: `references unknown identifier '${node.text}'` };
    }
  }

  // Recurse into children
  const children = node.getChildren();
  for (const child of children) {
    const result = checkNode(child, paramNames, localNames);
    if (result) return result;
  }

  return undefined;
}
