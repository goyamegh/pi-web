import { describe, expect, test } from "vitest";
import { splitUnifiedPatch } from "../src/components/diff.js";

describe("unified patch parsing", () => {
  test("splits a multi-file git patch into named file sections", () => {
    const patch = [
      "diff --git a/src/a.ts b/src/a.ts",
      "index 111..222 100644",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "diff --git a/src/b.ts b/src/b.ts",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/src/b.ts",
      "@@ -0,0 +1 @@",
      "+added",
    ].join("\n");

    expect(splitUnifiedPatch(patch).map((file) => file.name)).toEqual(["src/a.ts", "src/b.ts"]);
    expect(splitUnifiedPatch(patch)[1].lines).toContain("+added");
  });
});
