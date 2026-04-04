<script lang="ts">
	// import { search } from './search.remote';

	// using this function does not reproduce it anymore

	function search(v) {
		const promise = new Promise((resolve) => {
			setTimeout(() => {
				loading = false;
				resolve(
					[
						{ id: 1, title: 'Kind of Blue', artist: 'Miles Davis', year: 1959 },
						{ id: 2, title: 'Abbey Road', artist: 'The Beatles', year: 1969 },
						{ id: 3, title: 'The Dark Side of the Moon', artist: 'Pink Floyd', year: 1973 },
						{ id: 4, title: 'Rumours', artist: 'Fleetwood Mac', year: 1977 },
						{ id: 5, title: 'Thriller', artist: 'Michael Jackson', year: 1982 },
						{ id: 6, title: 'Back in Black', artist: 'AC/DC', year: 1980 },
						{ id: 7, title: 'Hotel California', artist: 'Eagles', year: 1976 },
						{ id: 8, title: 'Blue', artist: 'Joni Mitchell', year: 1971 }
					].filter((item) => item.title.toLowerCase().includes(v.toLowerCase()))
				);
			}, 1000);
		});
		let loading = $state(true);
		Object.defineProperty(promise, 'loading', {
			get() {
				return loading;
			}
		});
		return promise;
	}

	let query = $state('');

	const promise = $derived(search(query));
</script>

<div class="flex flex-col gap-8">
	<pre>{JSON.stringify({ query, filteredResults: await promise }, null, 2)}</pre>

	<div class="relative">
		<input type="text" bind:value={query} />
	</div>

	<div class="flex flex-col gap-4">
		<!-- {#if !loading} -->
		{#if !promise.loading}
			query value: {query}
		{/if}
	</div>
</div>
