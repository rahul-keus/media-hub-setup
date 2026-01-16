/**
 * GitHub Service - Generate GitHub URLs for downloading public repository content
 * No authentication required for public repositories
 */

/**
 * Get GitHub branch archive URL (tar.gz format)
 * @param {string} owner - GitHub username or organization
 * @param {string} repo - Repository name
 * @param {string} branch - Branch name (default: 'main')
 * @returns {string} Archive URL
 */
export function getBranchArchiveUrl(owner, repo, branch = 'main') {
  return `https://github.com/${owner}/${repo}/archive/refs/heads/${branch}.tar.gz`;
}

/**
 * Get GitHub raw file URL
 * @param {string} owner - GitHub username or organization
 * @param {string} repo - Repository name
 * @param {string} branch - Branch name (default: 'main')
 * @param {string} filePath - Path to file in repository
 * @returns {string} Raw file URL
 */
export function getRawFileUrl(owner, repo, branch, filePath) {
  return `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${filePath}`;
}

/**
 * Generate curl command to download file from GitHub
 * @param {string} url - URL to download
 * @param {string} outputPath - Path where file should be saved on hub
 * @returns {string} curl command
 */
export function generateCurlCommand(url, outputPath) {
  return `curl -L "${url}" -o "${outputPath}"`;
}

/**
 * Generate wget command to download file from GitHub (alternative to curl)
 * @param {string} url - URL to download
 * @param {string} outputPath - Path where file should be saved on hub
 * @returns {string} wget command
 */
export function generateWgetCommand(url, outputPath) {
  return `wget -O "${outputPath}" "${url}"`;
}

/**
 * Generate download command using the best available tool (curl or wget)
 * @param {string} url - URL to download
 * @param {string} outputPath - Path where file should be saved on hub
 * @param {string} tool - Preferred tool ('curl', 'wget', or 'auto' for auto-detect)
 * @returns {string} Download command
 */
export function generateDownloadCommand(url, outputPath, tool = 'auto') {
  if (tool === 'curl') {
    return generateCurlCommand(url, outputPath);
  } else if (tool === 'wget') {
    return generateWgetCommand(url, outputPath);
  } else {
    // Default to wget as it's more commonly available on minimal systems
    return generateWgetCommand(url, outputPath);
  }
}

/**
 * Generate command to extract tar.gz archive
 * @param {string} archivePath - Path to tar.gz file
 * @param {string} extractTo - Directory to extract to
 * @returns {string} tar extraction command
 */
export function generateExtractCommand(archivePath, extractTo) {
  return `tar -xzf "${archivePath}" -C "${extractTo}"`;
}

/**
 * Generate command to create directory
 * @param {string} dirPath - Directory path to create
 * @returns {string} mkdir command
 */
export function generateMkdirCommand(dirPath) {
  return `mkdir -p "${dirPath}"`;
}

/**
 * Get default repository configuration
 * @returns {object} Default repo config
 */
export function getDefaultRepoConfig() {
  return {
    owner: 'rahul-keus',
    repo: 'media-hub-setup',
    branch: 'main',
    basePath: '/data/hub-setup'
  };
}

