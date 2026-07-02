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

// --- Python ---------------------------------------------------------------
export const PYTHON_QUERY = `
(comment) @comment
(string) @string
[(integer) (float)] @number
[(true) (false) (none)] @constant.builtin
[
  "and" "as" "assert" "async" "await" "break" "class" "continue" "def"
  "del" "elif" "else" "except" "finally" "for" "from" "global" "if"
  "import" "in" "is" "lambda" "nonlocal" "not" "or" "pass" "raise"
  "return" "try" "while" "with" "yield"
] @keyword
(function_definition name: (identifier) @function)
(class_definition name: (identifier) @type)
(call function: (identifier) @function.call)
(call function: (attribute attribute: (identifier) @function.method))
(parameters (identifier) @variable.parameter)
(attribute attribute: (identifier) @property)
(decorator) @attribute
`;

// --- Rust ------------------------------------------------------------------
export const RUST_QUERY = `
[(line_comment) (block_comment)] @comment
[(string_literal) (raw_string_literal) (char_literal)] @string
[(integer_literal) (float_literal)] @number
["true" "false"] @constant.builtin
[
  "as" "async" "await" "break" "const" "continue" "else" "enum"
  "extern" "fn" "for" "if" "impl" "in" "let" "loop" "match" "mod"
  "move" "pub" "return" "static" "struct" "trait" "type"
  "unsafe" "use" "where" "while"
] @keyword
(mutable_specifier) @keyword
(type_identifier) @type
(primitive_type) @type.builtin
(function_item name: (identifier) @function)
(call_expression function: (identifier) @function.call)
(call_expression function: (field_expression field: (field_identifier) @function.method))
(macro_invocation macro: (identifier) @function)
(parameter pattern: (identifier) @variable.parameter)
(field_identifier) @property
`;

// --- Go --------------------------------------------------------------------
export const GO_QUERY = `
(comment) @comment
[(interpreted_string_literal) (raw_string_literal) (rune_literal)] @string
[(int_literal) (float_literal) (imaginary_literal)] @number
[
  "break" "case" "chan" "const" "continue" "default" "defer" "else"
  "fallthrough" "for" "func" "go" "goto" "if" "import" "interface"
  "map" "package" "range" "return" "select" "struct" "switch" "type" "var"
] @keyword
(type_identifier) @type
(function_declaration name: (identifier) @function)
(method_declaration name: (field_identifier) @function.method)
(call_expression function: (identifier) @function.call)
(call_expression function: (selector_expression field: (field_identifier) @function.method))
(parameter_declaration name: (identifier) @variable.parameter)
(field_identifier) @property
`;

// --- JSON ------------------------------------------------------------------
export const JSON_QUERY = `
(pair key: (string) @property)
(string) @string
(number) @number
[(true) (false) (null)] @constant.builtin
`;

// --- Bash ------------------------------------------------------------------
export const BASH_QUERY = `
(comment) @comment
[(string) (raw_string) (ansi_c_string) (heredoc_body)] @string
[
  "if" "then" "else" "elif" "fi" "case" "esac" "for" "while" "until"
  "do" "done" "in" "function" "select"
] @keyword
(command_name) @function
(function_definition name: (word) @function)
[(variable_name) (special_variable_name)] @variable
(simple_expansion) @variable
`;

// --- CSS -------------------------------------------------------------------
export const CSS_QUERY = `
(comment) @comment
(string_value) @string
[(integer_value) (float_value)] @number
(color_value) @number
(property_name) @property
(tag_name) @tag
(class_name) @type
(id_name) @type
(function_name) @function
(at_keyword) @keyword
(plain_value) @variable
`;

// --- HTML ------------------------------------------------------------------
export const HTML_QUERY = `
(comment) @comment
(doctype) @keyword
(tag_name) @tag
(attribute_name) @attribute
(quoted_attribute_value) @string
(attribute_value) @string
`;

// --- YAML ------------------------------------------------------------------
export const YAML_QUERY = `
(comment) @comment
[(single_quote_scalar) (double_quote_scalar) (string_scalar)] @string
[(integer_scalar) (float_scalar)] @number
[(boolean_scalar) (null_scalar)] @constant.builtin
(block_mapping_pair key: (flow_node) @property)
(flow_mapping (flow_pair key: (flow_node) @property))
[(anchor_name) (alias_name)] @type
(tag) @keyword
`;

// --- C ---------------------------------------------------------------------
export const C_QUERY = `
(comment) @comment
[(string_literal) (char_literal) (system_lib_string)] @string
(number_literal) @number
[
  "break" "case" "const" "continue" "default" "do" "else" "enum"
  "extern" "for" "goto" "if" "register" "return" "sizeof" "static"
  "struct" "switch" "typedef" "union" "volatile" "while"
] @keyword
(primitive_type) @type.builtin
(type_identifier) @type
(call_expression function: (identifier) @function.call)
(function_declarator declarator: (identifier) @function)
(field_identifier) @property
(preproc_directive) @keyword
`;

// --- C++ (superset of C) ---------------------------------------------------
export const CPP_QUERY = `
(comment) @comment
[(string_literal) (char_literal) (raw_string_literal) (system_lib_string)] @string
(number_literal) @number
[
  "break" "case" "catch" "class" "const" "constexpr" "continue" "default"
  "delete" "do" "else" "enum" "explicit" "extern" "for" "friend" "goto"
  "if" "inline" "namespace" "new" "noexcept" "operator" "override"
  "private" "protected" "public" "return" "sizeof" "static" "struct"
  "switch" "template" "throw" "try" "typedef" "typename" "union" "using"
  "virtual" "volatile" "while"
] @keyword
(primitive_type) @type.builtin
(type_identifier) @type
(namespace_identifier) @type
(call_expression function: (identifier) @function.call)
(function_declarator declarator: (identifier) @function)
(field_identifier) @property
(preproc_directive) @keyword
`;
