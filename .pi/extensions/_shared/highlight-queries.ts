/**
 * highlight-queries — vendored tree-sitter `highlights.scm` queries, inlined as
 * string constants so they travel with the module graph (no sibling files to
 * ship, no runtime path resolution). Capture names follow the common
 * tree-sitter highlight convention (`@keyword`, `@function.method`, …); the
 * highlighter maps them onto highlight.js `hljs-*` classes so the existing
 * extension CSS (which colors `.hljs-*` from the theme `--syn-*` palette) keeps
 * working unchanged.
 *
 * Queries avoid `#match?`/`#eq?` predicates on purpose: web-tree-sitter's
 * `captures()` does not evaluate predicates, so we lean on grammar node types
 * (e.g. `type_identifier`, `predefined_type`) to distinguish scopes instead.
 */

// Covers the `tsx` grammar, which is a superset that also parses plain TS, JS
// and JSX — so ts/tsx/js/jsx all share this one query.
export const TS_QUERY = `
; --- Comments -------------------------------------------------------------
(comment) @comment

; --- Literals -------------------------------------------------------------
(string) @string
(template_string) @string
(regex) @string
(number) @number
[
  (true)
  (false)
  (null)
  (undefined)
] @constant.builtin

; --- Keywords -------------------------------------------------------------
[
  "as" "async" "await" "break" "case" "catch" "class" "const" "continue"
  "debugger" "declare" "default" "delete" "do" "else" "enum" "export"
  "extends" "finally" "for" "from" "function" "get" "if" "implements"
  "import" "in" "instanceof" "interface" "keyof" "let" "namespace" "new"
  "of" "readonly" "return" "satisfies" "set" "static" "switch" "throw"
  "try" "type" "typeof" "var" "void" "while" "with" "yield"
] @keyword

; --- Types ----------------------------------------------------------------
(type_identifier) @type
(predefined_type) @type.builtin

; --- Functions ------------------------------------------------------------
(function_declaration name: (identifier) @function)
(function_expression name: (identifier) @function)
(method_definition name: (property_identifier) @function.method)
(call_expression
  function: (identifier) @function.call)
(call_expression
  function: (member_expression
    property: (property_identifier) @function.method))

; --- Parameters & properties ---------------------------------------------
(required_parameter pattern: (identifier) @variable.parameter)
(optional_parameter pattern: (identifier) @variable.parameter)
(member_expression property: (property_identifier) @property)
(property_identifier) @property
`;
