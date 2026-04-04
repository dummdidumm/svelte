import { query } from '$app/server';
import { users } from '$lib/users';
import { error, redirect } from '@sveltejs/kit';
import * as z from 'valibot';

export const getUser = query(z.string(), async (username) => {
	const response = users.find((user) => user.username === username);
	if (response && response.uuid && response.username) {
		console.log(`User found: ${response.username} (UUID: ${response.uuid})`);
		return {
			uuid: response.uuid,
			username: response.username
		};
	}
	error(404, `No user with the name '${username}' was found`);
});

export const searchUser = query(z.string(), async (username) => {
	const response = users.find((user) => user.username === username);
	if (response && response.uuid && response.username) {
		console.log(`User found: ${response.username} (UUID: ${response.uuid})`);
		redirect(302, `/boundary-redirect/search/${response.username}`);
	}
	error(404, `No user with the name '${username}' was found`);
});
