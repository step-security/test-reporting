import * as core from '@actions/core'
import * as github from '@actions/github'
import {createHash} from 'crypto'
import {GitHub} from '@actions/github/lib/utils'
import axios, {isAxiosError} from 'axios'

import {ArtifactProvider} from './input-providers/artifact-provider'
import {LocalFileProvider} from './input-providers/local-file-provider'
import {FileContent} from './input-providers/input-provider'
import {ParseOptions, TestParser} from './test-parser'
import {TestRunResult} from './test-results'
import {getAnnotations} from './report/get-annotations'
import {getReport} from './report/get-report'

import {DartJsonParser} from './parsers/dart-json/dart-json-parser'
import {DotnetTrxParser} from './parsers/dotnet-trx/dotnet-trx-parser'
import {JavaJunitParser} from './parsers/java-junit/java-junit-parser'
import {JestJunitParser} from './parsers/jest-junit/jest-junit-parser'
import {MochaJsonParser} from './parsers/mocha-json/mocha-json-parser'
import {MochawesomeJsonParser} from './parsers/mochawesome-json/mochawesome-json-parser'

import {normalizeDirPath, normalizeFilePath} from './utils/path-utils'
import {getCheckRunContext} from './utils/github-utils'
import {Outputs} from './utils/constants'

async function validateSubscription(): Promise<void> {
  const API_URL = `https://agent.api.stepsecurity.io/v1/github/${process.env.GITHUB_REPOSITORY}/actions/subscription`

  try {
    await axios.get(API_URL, {timeout: 3000})
  } catch (error) {
    if (isAxiosError(error) && error.response?.status === 403) {
      core.error('Subscription is not valid. Reach out to support@stepsecurity.io')
      process.exit(1)
    } else {
      core.info('Timeout or API not reachable. Continuing to next step.')
    }
  }
}

async function main(): Promise<void> {
  try {
    await validateSubscription()
    const testReporter = new TestReporter()
    await testReporter.run()
  } catch (error: any) {
    core.setFailed(error.message)
  }
}

function createSlugPrefix(): string {
  const step_summary = process.env['GITHUB_STEP_SUMMARY']
  if (!step_summary || step_summary === '') {
    return ''
  }
  const hash = createHash('sha1')
  hash.update(step_summary)
  return hash.digest('hex').substring(0, 8)
}

class TestReporter {
  readonly artifact = core.getInput('artifact', {required: false})
  readonly name = core.getInput('name', {required: true})
  readonly path = core.getInput('path', {required: true})
  readonly pathReplaceBackslashes = core.getInput('path-replace-backslashes', {required: false}) === 'true'
  readonly reporter = core.getInput('reporter', {required: true})
  readonly listSuites = core.getInput('list-suites', {required: true}) as 'all' | 'failed'
  readonly listTests = core.getInput('list-tests', {required: true}) as 'all' | 'failed' | 'none'
  readonly maxAnnotations = parseInt(core.getInput('max-annotations', {required: true}))
  readonly failOnError = core.getInput('fail-on-error', {required: true}) === 'true'
  readonly workDirInput = core.getInput('working-directory', {required: false})
  readonly onlySummary = core.getInput('only-summary', {required: false}) === 'true'
  readonly outputTo = core.getInput('output-to', {required: false})
  readonly token = core.getInput('token', {required: true})
  readonly slugPrefix: string = ''
  readonly octokit: InstanceType<typeof GitHub>
  readonly context = getCheckRunContext()

  constructor() {
    this.octokit = github.getOctokit(this.token)

    if (this.listSuites !== 'all' && this.listSuites !== 'failed') {
      core.setFailed(`Input parameter 'list-suites' has invalid value`)
      return
    }

    if (this.listTests !== 'all' && this.listTests !== 'failed' && this.listTests !== 'none') {
      core.setFailed(`Input parameter 'list-tests' has invalid value`)
      return
    }

    if (isNaN(this.maxAnnotations) || this.maxAnnotations < 0 || this.maxAnnotations > 50) {
      core.setFailed(`Input parameter 'max-annotations' has invalid value`)
      return
    }

    if (this.outputTo !== 'checks' && this.outputTo !== 'step-summary') {
      core.setFailed(`Input parameter 'output-to' has invalid value`)
      return
    }

    if (this.outputTo === 'step-summary') {
      this.slugPrefix = createSlugPrefix()
    }
  }

  async run(): Promise<void> {
    if (this.workDirInput) {
      core.info(`Changing directory to '${this.workDirInput}'`)
      process.chdir(this.workDirInput)
    }

    core.info(`Check runs will be created with SHA=${this.context.sha}`)

    // Split path pattern by ',' and optionally convert all backslashes to forward slashes
    // fast-glob (micromatch) always interprets backslashes as escape characters instead of directory separators
    const pathsList = this.path.split(',')
    const pattern = this.pathReplaceBackslashes ? pathsList.map(normalizeFilePath) : pathsList

    const inputProvider = this.artifact
      ? new ArtifactProvider(
          this.octokit,
          this.artifact,
          this.name,
          pattern,
          this.context.sha,
          this.context.runId,
          this.token
        )
      : new LocalFileProvider(this.name, pattern)

    const parseErrors = this.maxAnnotations > 0
    const trackedFiles = await inputProvider.listTrackedFiles()
    const workDir = this.artifact ? undefined : normalizeDirPath(process.cwd(), true)

    core.info(`Found ${trackedFiles.length} files tracked by GitHub`)

    const options: ParseOptions = {
      workDir,
      trackedFiles,
      parseErrors
    }

    core.info(`Using test report parser '${this.reporter}'`)
    const parser = this.getParser(this.reporter, options)

    const results: TestRunResult[] = []
    const input = await inputProvider.load()
    for (const [reportName, files] of Object.entries(input)) {
      try {
        core.startGroup(`Creating test report ${reportName}`)
        const tr = await this.createReport(parser, reportName, files)
        results.push(...tr)
      } finally {
        core.endGroup()
      }
    }

    const isFailed = results.some(tr => tr.result === 'failed')
    const conclusion = isFailed ? 'failure' : 'success'
    const passed = results.reduce((sum, tr) => sum + tr.passed, 0)
    const failed = results.reduce((sum, tr) => sum + tr.failed, 0)
    const skipped = results.reduce((sum, tr) => sum + tr.skipped, 0)
    const time = results.reduce((sum, tr) => sum + tr.time, 0)

    core.setOutput('conclusion', conclusion)
    core.setOutput('passed', passed)
    core.setOutput('failed', failed)
    core.setOutput('skipped', skipped)
    core.setOutput('time', time)

    if (this.failOnError && isFailed) {
      core.setFailed(`Failed tests were found and 'fail-on-error' option is set to ${this.failOnError}`)
      return
    }

    if (results.length === 0) {
      core.setFailed(`No test report files were found`)
      return
    }
  }

  async createReport(parser: TestParser, name: string, files: FileContent[]): Promise<TestRunResult[]> {
    if (files.length === 0) {
      core.warning(`No file matches path ${this.path}`)
      return []
    }

    const results: TestRunResult[] = []
    for (const {file, content} of files) {
      core.info(`Processing test results from ${file}`)
      const tr = await parser.parse(file, content)
      results.push(tr)
    }

    let createResp = null
    let baseUrl = ''
    let check_run_id = 0

    switch (this.outputTo) {
      case 'checks': {
        core.info(`Creating check run ${name}`)
        createResp = await this.octokit.rest.checks.create({
          head_sha: this.context.sha,
          name,
          status: 'in_progress',
          output: {
            title: name,
            summary: ''
          },
          ...github.context.repo
        })
        baseUrl = createResp.data.html_url as string
        check_run_id = createResp.data.id
        break
      }
      case 'step-summary': {
        const run_attempt = process.env['GITHUB_RUN_ATTEMPT'] ?? 1
        baseUrl = `https://github.com/${github.context.repo.owner}/${github.context.repo.repo}/actions/runs/${github.context.runId}/attempts/${run_attempt}`
        break
      }
    }

    core.info('Creating report summary')
    const {listSuites, listTests, onlySummary, slugPrefix} = this
    const summary = getReport(results, {listSuites, listTests, baseUrl, slugPrefix, onlySummary})

    core.info('Creating annotations')
    const annotations = getAnnotations(results, this.maxAnnotations)

    const isFailed = results.some(tr => tr.result === 'failed')
    const conclusion = isFailed ? 'failure' : 'success'

    const passed = results.reduce((sum, tr) => sum + tr.passed, 0)
    const failed = results.reduce((sum, tr) => sum + tr.failed, 0)
    const skipped = results.reduce((sum, tr) => sum + tr.skipped, 0)
    const shortSummary = `${passed} passed, ${failed} failed and ${skipped} skipped `

    core.info(`Updating check run conclusion (${conclusion}) and output`)
    switch (this.outputTo) {
      case 'checks': {
        const resp = await this.octokit.rest.checks.update({
          check_run_id,
          conclusion,
          status: 'completed',
          output: {
            title: shortSummary,
            summary,
            annotations
          },
          ...github.context.repo
        })
        core.info(`Check run create response: ${resp.status}`)
        core.info(`Check run URL: ${resp.data.url}`)
        core.info(`Check run HTML: ${resp.data.html_url}`)
        core.setOutput(Outputs.runHtmlUrl, `${resp.data.html_url}`)
        break
      }
      case 'step-summary': {
        core.summary.addRaw(`# ${shortSummary}`)
        core.summary.addRaw(summary)
        await core.summary.write()
        for (const annotation of annotations) {
          let fn
          switch (annotation.annotation_level) {
            case 'failure':
              fn = core.error
              break
            case 'warning':
              fn = core.warning
              break
            case 'notice':
              fn = core.notice
              break
            default:
              continue
          }

          fn(annotation.message, {
            title: annotation.title,
            file: annotation.path,
            startLine: annotation.start_line,
            endLine: annotation.end_line,
            startColumn: annotation.start_column,
            endColumn: annotation.end_column
          })
        }
        break
      }
    }

    return results
  }

  getParser(reporter: string, options: ParseOptions): TestParser {
    switch (reporter) {
      case 'dart-json':
        return new DartJsonParser(options, 'dart')
      case 'dotnet-trx':
        return new DotnetTrxParser(options)
      case 'flutter-json':
        return new DartJsonParser(options, 'flutter')
      case 'java-junit':
        return new JavaJunitParser(options)
      case 'jest-junit':
        return new JestJunitParser(options)
      case 'mocha-json':
        return new MochaJsonParser(options)
      case 'mochawesome-json':
        return new MochawesomeJsonParser(options)
      default:
        throw new Error(`Input variable 'reporter' is set to invalid value '${reporter}'`)
    }
  }
}

main()
