import { promises as fs } from "fs"
import core from "@actions/core"
import { GitHub, context } from "@actions/github"
import path from "path"

import { parse } from "./lcov"
import { diff } from "./comment"
import { getChangedFiles } from "./get_changes"
import { deleteOldComments } from "./delete_old_comments"
import { normalisePath } from "./util"

const MAX_COMMENT_CHARS = 65536

async function main() {
	const token = core.getInput("github-token")
	const githubClient = new GitHub(token)
	const workingDir = core.getInput('working-directory') || './';	
	const lcovFile = path.join(workingDir, core.getInput("lcov-file") || "./coverage/lcov.info")
	const baseFile = core.getInput("lcov-base")
	const eventFile = core.getInput("event")
	const shouldFilterChangedFiles =
		core.getInput("filter-changed-files").toLowerCase() === "true"
	const shouldDeleteOldComments =
		core.getInput("delete-old-comments").toLowerCase() === "true"
	const title = core.getInput("title")

	const raw = await fs.readFile(lcovFile, "utf-8").catch(err => null)
	if (!raw) {
		console.log(`No coverage report found at '${lcovFile}', exiting...`)
		return
	}

	const baseRaw =
		baseFile && (await fs.readFile(baseFile, "utf-8").catch(err => null))
	if (baseFile && !baseRaw) {
		console.log(`No coverage report found at '${baseFile}', ignoring...`)
	}

	const eventRaw =
		eventFile && (await fs.readFile(eventFile, "utf-8").catch(err => null));
	if (eventFile && !eventRaw) {
		console.log(`Failed to read event data from '${eventFile}', ignoring...`);
	}
	const event_data = eventRaw ? JSON.parse(eventRaw) : context.payload;

	const options = {
		repository: event_data.repository.full_name,
		prefix: normalisePath(`${process.env.GITHUB_WORKSPACE}/`),
		workingDir,
	}

	if (event_data.pull_request) {
		options.commit = event_data.pull_request.head.sha
		options.baseCommit = event_data.pull_request.base.sha
		options.head = event_data.pull_request.head.ref
		options.base = event_data.pull_request.base.ref
		options.issue_number = event_data.number
	} else if (event_data.push) {
		options.commit = event_data.after
		options.baseCommit = event_data.before
		options.head = event_data.ref
	}

	options.shouldFilterChangedFiles = shouldFilterChangedFiles
	options.title = title

	if (shouldFilterChangedFiles) {
		options.changedFiles = await getChangedFiles(githubClient, options, context)
	}

	const lcov = await parse(raw)
	const baselcov = baseRaw && (await parse(baseRaw))
	const body = diff(lcov, baselcov, options).substring(0, MAX_COMMENT_CHARS)

	if (shouldDeleteOldComments) {
		await deleteOldComments(githubClient, options, context)
	}

	if (event_data.pull_request) {
		await githubClient.issues.createComment({
			repo: context.repo.repo,
			owner: context.repo.owner,
			issue_number: event_data.number,
			body: body,
		})
	} else if (event_data.push) {
		await githubClient.repos.createCommitComment({
			repo: context.repo.repo,
			owner: context.repo.owner,
			commit_sha: options.commit,
			body: body,
		})
	}
}

main().catch(function(err) {
	console.log(err)
	core.setFailed(err.message)
})
