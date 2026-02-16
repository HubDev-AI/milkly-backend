import { createDebugger } from "../lib/debug";

const debug = createDebugger("TEMPLATE-CONTENT");

/**
 * Strip editorial content from template mkly source, keeping only structure
 * (blocks, themes, presets, styles, structural properties).
 *
 * Uses runtime dynamic imports for mkly monorepo packages.
 */
export async function stripTemplateContent(mklySource: string): Promise<string> {
  // @ts-expect-error -- monorepo sibling import resolved by Bun at runtime
  const { stripContent, CORE_KIT } = await import("../../milkly-mklyml/mkly/src/index");
  // @ts-expect-error -- monorepo sibling import resolved by Bun at runtime
  const { NEWSLETTER_KIT } = await import("../../milkly-mklyml/mkly-kits/newsletter/src/index");

  const kits = { core: CORE_KIT, newsletter: NEWSLETTER_KIT };
  const stripped = stripContent(mklySource, kits);
  debug(`Stripped template content: ${mklySource.length} → ${stripped.length} chars`);
  return stripped;
}
