// Test-only: source files import siblings without an extension, as the Worker
// bundler allows. Node needs the ".ts", so retry a failed relative import with it.
import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (error?.code !== "ERR_MODULE_NOT_FOUND" || !/^\.\.?\//u.test(specifier)) throw error;
      return nextResolve(`${specifier}.ts`, context);
    }
  },
});
