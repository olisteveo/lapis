// Lets Node run the engine-free TypeScript in src/core directly: extensionless relative imports
// resolve to their .ts files. Used with --experimental-transform-types.
export async function resolve(specifier, context, next) {
  try {
    return await next(specifier, context);
  } catch (err) {
    if (specifier.startsWith('.') && !specifier.endsWith('.ts')) return next(specifier + '.ts', context);
    throw err;
  }
}
