// @ts-check

import fs from 'fs'
import path from 'path'
import isGlob from 'is-glob'
import fastGlob from 'fast-glob'
import normalizePath from 'normalize-path'
import { flagEnabled } from '../featureFlags.js'
import { parseGlob } from '../util/parseGlob'
import { env } from './sharedState'

/** @typedef {import('../../types/config.js').RawFile} RawFile */
/** @typedef {import('../../types/config.js').FilePath} FilePath */

/**
 * @typedef {object} ContentPath
 * @property {string} original
 * @property {string} base
 * @property {string | null} glob
 */

/**
 * Turn a list of content paths (absolute or not; glob or not) into a list of
 * absolute file paths that exist on the filesystem
 *
 * If there are symlinks in the path then multiple paths will be returned
 * one for the symlink and one for the actual file
 *
 * @param {*} context
 * @param {import('tailwindcss').Config} tailwindConfig
 * @returns {ContentPath[]}
 */
export function parseCandidateFiles(context, tailwindConfig) {
  let files = tailwindConfig.content.files

  return files.flatMap((contentPath) => parseContentPath(context, contentPath))
}

/**
 *
 * @param {any} context
 * @param {RawFile | FilePath} filePath
 * @returns {ContentPath[]}
 */
function parseContentPath(context, filePath) {
  if (typeof filePath !== 'string') {
    return []
  }

  filePath = normalizePath(filePath)

  /** @type {ContentPath[]} */
  let paths = []

  if (isGlob(filePath)) {
    let { base, glob } = parseGlob(filePath)

    paths.push({ original: filePath, base: base, glob })
  } else {
    paths.push({ original: filePath, base: filePath, glob: null })
  }

  paths = resolveRelativePaths(context, paths)
  paths = paths.flatMap(resolvePathSymlinks)

  return paths
}

/**
 * Resolve each path relative to the config file (when possible) if the experimental flag is enabled
 * Otherwise, resolve relative to the current working directory
 *
 * @param {any} context
 * @param {ContentPath[]} contentPaths
 * @returns {ContentPath[]}
 */
function resolveRelativePaths(context, contentPaths) {
  let resolveFrom = []

  // Resolve base paths relative to the config file (when possible) if the experimental flag is enabled
  if (
    context.userConfigPath &&
    flagEnabled(context.tailwindConfig, 'resolveContentRelativeToConfig')
  ) {
    resolveFrom = [path.dirname(context.userConfigPath)]
  }

  return contentPaths.map((contentPath) =>
    Object.assign(contentPath, {
      base: path.resolve(...resolveFrom, contentPath.base),
    })
  )
}

/**
 * Resolve the symlink for the base directory / file in each path
 * These are added as additional dependencies to watch for changes because
 * some tools (like webpack) will only watch the actual file or directory
 * but not the symlink itself even in projects that use monorepos.
 *
 * @param {ContentPath} contentPath
 * @returns {ContentPath[]}
 */
function resolvePathSymlinks(contentPath) {
  try {
    let newPath = fs.realpathSync(contentPath.base, { encoding: 'utf8' })
    if (newPath !== contentPath.base) {
      return [contentPath, { ...contentPath, base: newPath }]
    }
  } catch {
    // TODO: log this?
  }

  return [contentPath]
}

/**
 * @param {any} context
 * @param {ContentPath[]} candidateFiles
 * @param {Map<string, number>} fileModifiedMap
 * @returns {{ content: string, extension: string }[]}
 */
export function resolvedChangedContent(context, candidateFiles, fileModifiedMap) {
  let changedContent = context.tailwindConfig.content.files
    .filter((item) => typeof item.raw === 'string')
    .map(({ raw, extension = 'html' }) => ({ content: raw, extension }))

  for (let changedFile of resolveChangedFiles(candidateFiles, fileModifiedMap)) {
    let content = fs.readFileSync(changedFile, 'utf8')
    let extension = path.extname(changedFile).slice(1)
    changedContent.push({ content, extension })
  }

  return changedContent
}

/**
 *
 * @param {ContentPath[]} candidateFiles
 * @param {Map<string, number>} fileModifiedMap
 * @returns {Set<string>}
 */
function resolveChangedFiles(candidateFiles, fileModifiedMap) {
  let paths = candidateFiles.map((contentPath) =>
    contentPath.original.startsWith('!')
      ? contentPath.original
      : contentPath.glob
      ? `${contentPath.base}/${contentPath.glob}`
      : contentPath.base
  )

  let changedFiles = new Set()
  env.DEBUG && console.time('Finding changed files')
  let files = fastGlob.sync(paths, { absolute: true })
  for (let file of files) {
    let prevModified = fileModifiedMap.has(file) ? fileModifiedMap.get(file) : -Infinity
    let modified = fs.statSync(file).mtimeMs

    if (modified > prevModified) {
      changedFiles.add(file)
      fileModifiedMap.set(file, modified)
    }
  }
  env.DEBUG && console.timeEnd('Finding changed files')
  return changedFiles
}
