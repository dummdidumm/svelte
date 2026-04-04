import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const output_file_path = resolve(process.cwd(), 'runtime-runes-failures.json');
const test_command = 'pnpm';
const test_args = ['test', 'runtime-runes'];
const should_promote = process.argv.includes('--promote');

const ansi_escape_regex = /\u001b\[[0-9;]*m/g;
const fail_line_regex = /\bFAIL\s+(.+?)\s+>\s+(.+)$/;

function strip_ansi(input) {
	return input.replace(ansi_escape_regex, '');
}

function parse_failures(raw_output) {
	const seen_keys = new Set();
	const failed_tests = [];

	for (const raw_line of raw_output.split(/\r?\n/)) {
		const line = strip_ansi(raw_line).trimEnd();
		const match = line.match(fail_line_regex);

		if (!match) continue;

		const file = match[1].trim();
		const test_name = match[2].trim();
		const key = `${file} > ${test_name}`;

		if (seen_keys.has(key)) continue;
		seen_keys.add(key);

		failed_tests.push({
			file,
			test_name,
			key
		});
	}

	return failed_tests;
}

async function load_existing_report() {
	if (!existsSync(output_file_path)) {
		return {
			current: {
				command: `${test_command} ${test_args.join(' ')}`,
				captured_at: null,
				failed_count: 0,
				failed_tests: []
			},
			pending: {
				command: `${test_command} ${test_args.join(' ')}`,
				captured_at: null,
				failed_count: 0,
				failed_tests: []
			}
		};
	}

	try {
		const raw_content = await readFile(output_file_path, 'utf8');
		const parsed = JSON.parse(raw_content);

		return {
			current: {
				command: parsed?.current?.command ?? `${test_command} ${test_args.join(' ')}`,
				captured_at: parsed?.current?.captured_at ?? null,
				failed_count: parsed?.current?.failed_count ?? 0,
				failed_tests: Array.isArray(parsed?.current?.failed_tests)
					? parsed.current.failed_tests
					: []
			},
			pending: {
				command: parsed?.pending?.command ?? `${test_command} ${test_args.join(' ')}`,
				captured_at: parsed?.pending?.captured_at ?? null,
				failed_count: parsed?.pending?.failed_count ?? 0,
				failed_tests: Array.isArray(parsed?.pending?.failed_tests)
					? parsed.pending.failed_tests
					: []
			}
		};
	} catch {
		return {
			current: {
				command: `${test_command} ${test_args.join(' ')}`,
				captured_at: null,
				failed_count: 0,
				failed_tests: []
			},
			pending: {
				command: `${test_command} ${test_args.join(' ')}`,
				captured_at: null,
				failed_count: 0,
				failed_tests: []
			}
		};
	}
}

function compare_failures(current_failed_tests, pending_failed_tests) {
	const current_keys = new Set(current_failed_tests.map((item) => item.key));
	const pending_keys = new Set(pending_failed_tests.map((item) => item.key));

	const newly_failing = pending_failed_tests.filter((item) => !current_keys.has(item.key));
	const now_fixed = current_failed_tests.filter((item) => !pending_keys.has(item.key));

	return { newly_failing, now_fixed };
}

async function run_tests_and_capture_output() {
	return new Promise((resolve_run) => {
		const child = spawn(test_command, test_args, {
			shell: true,
			stdio: ['inherit', 'pipe', 'pipe']
		});

		let combined_output = '';

		child.stdout.on('data', (chunk) => {
			const text = chunk.toString();
			combined_output += text;
			process.stdout.write(text);
		});

		child.stderr.on('data', (chunk) => {
			const text = chunk.toString();
			combined_output += text;
			process.stderr.write(text);
		});

		child.on('close', (exit_code) => {
			resolve_run({
				exit_code: exit_code ?? 1,
				output: combined_output
			});
		});
	});
}

async function main() {
	const existing_report = await load_existing_report();

	if (should_promote) {
		const promoted_report = {
			current: existing_report.pending,
			pending: existing_report.pending
		};

		await writeFile(output_file_path, JSON.stringify(promoted_report, null, 2) + '\n', 'utf8');

		console.log('Promoted pending failures to current baseline in runtime-runes-failures.json');
		console.log(`Current failing tests: ${promoted_report.current.failed_count}`);
		return;
	}

	const run_result = await run_tests_and_capture_output();

	const failed_tests = parse_failures(run_result.output);

	const pending = {
		command: `${test_command} ${test_args.join(' ')}`,
		captured_at: new Date().toISOString(),
		failed_count: failed_tests.length,
		failed_tests
	};

	const next_report = {
		current: existing_report.current,
		pending
	};

	await writeFile(output_file_path, JSON.stringify(next_report, null, 2) + '\n', 'utf8');

	const { newly_failing, now_fixed } = compare_failures(
		next_report.current.failed_tests,
		next_report.pending.failed_tests
	);

	console.log('\nFailing test analysis written to runtime-runes-failures.json');
	console.log(`Pending failing tests: ${next_report.pending.failed_count}`);
	console.log(`Newly failing tests: ${newly_failing.length}`);
	console.log(`Now fixed tests: ${now_fixed.length}`);

	if (newly_failing.length > 0) {
		console.log('\nNew failures:');
		for (const item of newly_failing) {
			console.log(`- ${item.key}`);
		}
	}

	if (now_fixed.length > 0) {
		console.log('\nFixed since current baseline:');
		for (const item of now_fixed) {
			console.log(`- ${item.key}`);
		}
	}

	if (run_result.exit_code !== 0) {
		process.exitCode = run_result.exit_code;
	}
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
