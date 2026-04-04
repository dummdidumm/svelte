---
agent: agent
---

Analyze the given issue.

You are an expert at fixing Svelte issues. You have tools to write files in the test directory, run tests, and read files.

Your goal is to fix the bug of the linked issue.

## Instructions:

1. Read the issue carefully to understand the bug.
2. If the issue references a Svelte playground link as a reproduction, use the download.js script to download and create a test (example: node playgrounds/sandbox/scripts/download.js --create-test a-fitting-test-name "https://svelte.dev/playground/some-playground-url-you-find-in-the-issue"). Add "solo: true" to the test object in \_config.js to only run this single test. Run "pnpm test runtime-runes" to run the test
3. Write a \_config.js that reproduces the issue given the test files. If there are errors or the test doesn't fail for the right reasons, read the output, fix the config, and try again
4. When the test runs and FAILS as expected, ONLY THEN try to minify it a bit by removing unnecessary html or styling. Remember to always check \_config.js after you removed code in case you need adjust assertions
5. Once the test is on good shape, fix the bug. Iterate and debug until the test passes. Once the test passes remove "solo: true" from \_config.js and run "pnpm test" to ensure all other tests still pass (i.e. no regressions from fixing the bug). If other tests fail, continue to iterate until all pass.

### Key patterns for writing tests:

- Use \`test\` function from '../../test'
- Always include \`solo: true\` to run only this test
- Use \`await tick()\` from 'svelte' after state changes
- Use \`target.querySelector\` to select elements and interact with them, PREFER that over programmatically setting state
- AVOID using \`component\` from the \`test\` helper
- Use \`assert.htmlEqual(target.innerHTML, expected)\` to check output
- The test should FAIL to demonstrate the bug exists
- If a test fails with a compiler error then the test is likely wrong
- If a test fails with something like "Cannot use X in runes mode" then add <svelte:options runes={false} /> at the top of the offending Svelte file
- If a test includes top level await or `await` expressions inside the template then prepend the test name with "async-"
- you can check other tests inside packages/svelte/tests/runtime-runes/samples to get a feel for how to write tests

### Key pointers for fixing bugs:

- you find the Svelte source code in packages/svelte. In there, src/compiler contains code that turns Svelte syntax into JS. src/internal contains the runtime.
- key files for client-side reactivity runtime are inside src/internal/clinet/reactivity
- Svelte runtime is based on signals (signals, deriveds, effects are the core parts)
