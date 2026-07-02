// highlight.js 10.x ships types for its main entry points but not for the
// individual language modules under `lib/languages/`. Each exports a
// `LanguageFn`; we only pass them to `hljs.registerLanguage`, so a permissive
// declaration is enough to keep `tsc --noEmit` clean.
declare module "highlight.js/lib/languages/*" {
    import type { LanguageFn } from "highlight.js";
    const language: LanguageFn;
    export default language;
}
