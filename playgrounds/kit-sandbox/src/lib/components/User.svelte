<script lang="ts">
	const { data }: { data: { uuid: string; username: string } } = $props();
</script>

<div class="flex h-screen items-center justify-center">
	<div class="text-center">
		<h1 class="mb-4 text-4xl font-bold">User Found!</h1>
		<p class="mb-6 text-lg">Username: <strong>{data.username}</strong></p>
		<p class="mb-6 text-lg">UUID: <strong>{data.uuid}</strong></p>
	</div>
</div>
