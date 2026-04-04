export default {
	/** @type {import('svelte/compiler').CompileOptions} */
	compilerOptions: {
		css: 'injected',

		hmr: false,
		dev: true,

		experimental: {
			async: true
		}
	}
};
