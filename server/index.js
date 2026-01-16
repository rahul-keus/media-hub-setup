import express from 'express';
import cors from 'cors';
import { SSHService } from './ssh-service.js';
import {
  getBranchArchiveUrl,
  getRawFileUrl,
  generateCurlCommand,
  generateWgetCommand,
  generateDownloadCommand,
  generateExtractCommand,
  generateMkdirCommand,
  getDefaultRepoConfig,
} from './github-service.js';

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('ui'));

// Store active SSH connections and streams
const activeConnections = new Map();
const activeStreams = new Map();

/**
 * Get or create SSH service for a connection
 */
function getSSHService(ip, username, password) {
  const key = `${ip}:${username}`;
  if (!activeConnections.has(key)) {
    const sshService = new SSHService();
    activeConnections.set(key, sshService);
  }
  return activeConnections.get(key);
}

/**
 * Detect which download tool is available on the hub (curl or wget)
 * @param {SSHService} sshService - SSH service instance
 * @returns {Promise<string>} 'curl', 'wget', or null if neither available
 */
async function detectDownloadTool(sshService) {
  // Check for curl first
  const curlCheck = await sshService.executeCommand('which curl').catch(() => null);
  if (curlCheck && curlCheck.code === 0 && curlCheck.stdout.trim()) {
    return 'curl';
  }

  // Check for wget
  const wgetCheck = await sshService.executeCommand('which wget').catch(() => null);
  if (wgetCheck && wgetCheck.code === 0 && wgetCheck.stdout.trim()) {
    return 'wget';
  }

  return null;
}

/**
 * POST /api/ssh/connect - Connect to hub via SSH
 */
app.post('/api/ssh/connect', async (req, res) => {
  try {
    const { ip, username, password } = req.body;

    if (!ip || !username || !password) {
      return res.status(400).json({ error: 'IP, username, and password are required' });
    }

    const sshService = getSSHService(ip, username, password);
    await sshService.connect(ip, username, password);

    res.json({ success: true, message: 'Connected successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/ssh/execute - Execute SSH command
 */
app.post('/api/ssh/execute', async (req, res) => {
  try {
    const { ip, username, password, command, cwd } = req.body;

    if (!ip || !username || !password || !command) {
      return res.status(400).json({ error: 'IP, username, password, and command are required' });
    }

    const sshService = getSSHService(ip, username, password);
    
    // Ensure connected
    if (!sshService.isConnected()) {
      await sshService.connect(ip, username, password);
    }

    const result = await sshService.executeCommand(command, { cwd });

    res.json({
      success: true,
      stdout: result.stdout,
      stderr: result.stderr,
      code: result.code,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/ssh/execute-stream - Execute SSH command with streaming output (SSE)
 */
app.post('/api/ssh/execute-stream', async (req, res) => {
  try {
    const { ip, username, password, command, cwd } = req.body;

    if (!ip || !username || !password || !command) {
      return res.status(400).json({ error: 'IP, username, password, and command are required' });
    }

    const sshService = getSSHService(ip, username, password);
    
    // Ensure connected
    if (!sshService.isConnected()) {
      await sshService.connect(ip, username, password);
    }

    // Set SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    // Send initial connection message
    res.write(`data: ${JSON.stringify({ type: 'connected', message: 'Connected to hub' })}\n\n`);

    // Execute command with streaming
    try {
      await sshService.executeCommandWithStream(command, {
        cwd,
        onStdout: (chunk) => {
          res.write(`data: ${JSON.stringify({ type: 'stdout', data: chunk })}\n\n`);
        },
        onStderr: (chunk) => {
          res.write(`data: ${JSON.stringify({ type: 'stderr', data: chunk })}\n\n`);
        },
      });

      res.write(`data: ${JSON.stringify({ type: 'done', message: 'Command completed' })}\n\n`);
    } catch (error) {
      res.write(`data: ${JSON.stringify({ type: 'error', error: error.message })}\n\n`);
    }

    res.end();
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/github/download-branch - Download entire branch from GitHub on hub
 */
app.post('/api/github/download-branch', async (req, res) => {
  try {
    const { ip, username, password, owner, repo, branch, basePath } = req.body;

    if (!ip || !username || !password) {
      return res.status(400).json({ error: 'IP, username, and password are required' });
    }

    const config = getDefaultRepoConfig();
    const repoOwner = owner || config.owner;
    const repoName = repo || config.repo;
    const repoBranch = branch || config.branch;
    const hubBasePath = basePath || config.basePath;

    const sshService = getSSHService(ip, username, password);
    
    if (!sshService.isConnected()) {
      await sshService.connect(ip, username, password);
    }

    // Set SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    try {
      // Create base directory
      res.write(`data: ${JSON.stringify({ type: 'info', message: 'Creating directory...' })}\n\n`);
      const mkdirCmd = generateMkdirCommand(hubBasePath);
      await sshService.executeCommand(mkdirCmd);
      res.write(`data: ${JSON.stringify({ type: 'info', message: 'Directory created' })}\n\n`);

      // Detect available download tool
      res.write(`data: ${JSON.stringify({ type: 'info', message: 'Checking for download tools...' })}\n\n`);
      const downloadTool = await detectDownloadTool(sshService);
      
      if (!downloadTool) {
        throw new Error('Neither curl nor wget is available on the hub. Please install one of them.');
      }

      res.write(`data: ${JSON.stringify({ type: 'info', message: `Using ${downloadTool} for download...` })}\n\n`);

      // Download archive
      res.write(`data: ${JSON.stringify({ type: 'info', message: 'Downloading branch archive...' })}\n\n`);
      const archiveUrl = getBranchArchiveUrl(repoOwner, repoName, repoBranch);
      const archivePath = `${hubBasePath}/repo.tar.gz`;
      const downloadCmd = generateDownloadCommand(archiveUrl, archivePath, downloadTool);

      const downloadResult = await sshService.executeCommandWithStream(downloadCmd, {
        onStdout: (chunk) => {
          res.write(`data: ${JSON.stringify({ type: 'stdout', data: chunk })}\n\n`);
        },
        onStderr: (chunk) => {
          res.write(`data: ${JSON.stringify({ type: 'stderr', data: chunk })}\n\n`);
        },
      });

      // Check if download was successful
      const fileCheck = await sshService.executeCommand(`test -f "${archivePath}" && echo "exists"`).catch(() => ({ stdout: '' }));
      if (!fileCheck.stdout.includes('exists')) {
        throw new Error('Download failed - file not found after download');
      }

      res.write(`data: ${JSON.stringify({ type: 'success', message: 'Download completed', archivePath })}\n\n`);
      res.end();
    } catch (error) {
      res.write(`data: ${JSON.stringify({ type: 'error', error: error.message })}\n\n`);
      res.end();
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/github/download-file - Download specific file from GitHub on hub
 */
app.post('/api/github/download-file', async (req, res) => {
  try {
    const { ip, username, password, owner, repo, branch, filePath, outputPath } = req.body;

    if (!ip || !username || !password || !filePath) {
      return res.status(400).json({ error: 'IP, username, password, and filePath are required' });
    }

    const config = getDefaultRepoConfig();
    const repoOwner = owner || config.owner;
    const repoName = repo || config.repo;
    const repoBranch = branch || config.branch;
    const hubBasePath = config.basePath;

    const sshService = getSSHService(ip, username, password);
    
    if (!sshService.isConnected()) {
      await sshService.connect(ip, username, password);
    }

    // Set SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    try {
      // Detect available download tool
      const downloadTool = await detectDownloadTool(sshService);
      
      if (!downloadTool) {
        throw new Error('Neither curl nor wget is available on the hub. Please install one of them.');
      }

      const fileUrl = getRawFileUrl(repoOwner, repoName, repoBranch, filePath);
      const remotePath = outputPath || `${hubBasePath}/${filePath.split('/').pop()}`;

      res.write(`data: ${JSON.stringify({ type: 'info', message: `Downloading ${filePath} using ${downloadTool}...` })}\n\n`);

      const downloadCmd = generateDownloadCommand(fileUrl, remotePath, downloadTool);

      await sshService.executeCommandWithStream(downloadCmd, {
        onStdout: (chunk) => {
          res.write(`data: ${JSON.stringify({ type: 'stdout', data: chunk })}\n\n`);
        },
        onStderr: (chunk) => {
          res.write(`data: ${JSON.stringify({ type: 'stderr', data: chunk })}\n\n`);
        },
      });

      // Check if download was successful
      const fileCheck = await sshService.executeCommand(`test -f "${remotePath}" && echo "exists"`).catch(() => ({ stdout: '' }));
      if (!fileCheck.stdout.includes('exists')) {
        throw new Error('Download failed - file not found after download');
      }

      res.write(`data: ${JSON.stringify({ type: 'success', message: 'File downloaded', path: remotePath })}\n\n`);
      res.end();
    } catch (error) {
      res.write(`data: ${JSON.stringify({ type: 'error', error: error.message })}\n\n`);
      res.end();
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/github/extract - Extract downloaded archive on hub
 */
app.post('/api/github/extract', async (req, res) => {
  try {
    const { ip, username, password, archivePath, extractTo } = req.body;

    if (!ip || !username || !password || !archivePath) {
      return res.status(400).json({ error: 'IP, username, password, and archivePath are required' });
    }

    const config = getDefaultRepoConfig();
    const hubBasePath = extractTo || config.basePath;

    const sshService = getSSHService(ip, username, password);
    
    if (!sshService.isConnected()) {
      await sshService.connect(ip, username, password);
    }

    // Set SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    try {
      res.write(`data: ${JSON.stringify({ type: 'info', message: 'Extracting archive...' })}\n\n`);

      const extractCmd = generateExtractCommand(archivePath, hubBasePath);

      await sshService.executeCommandWithStream(extractCmd, {
        onStdout: (chunk) => {
          res.write(`data: ${JSON.stringify({ type: 'stdout', data: chunk })}\n\n`);
        },
        onStderr: (chunk) => {
          res.write(`data: ${JSON.stringify({ type: 'stderr', data: chunk })}\n\n`);
        },
      });

      res.write(`data: ${JSON.stringify({ type: 'success', message: 'Extraction completed', path: hubBasePath })}\n\n`);
      res.end();
    } catch (error) {
      res.write(`data: ${JSON.stringify({ type: 'error', error: error.message })}\n\n`);
      res.end();
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/setup/download-and-run - One-click setup: download repo, extract, and run hub-setup.js
 */
app.post('/api/setup/download-and-run', async (req, res) => {
  try {
    const { ip, username, password, owner, repo, branch, basePath } = req.body;

    if (!ip || !username || !password) {
      return res.status(400).json({ error: 'IP, username, and password are required' });
    }

    const config = getDefaultRepoConfig();
    const repoOwner = owner || config.owner;
    const repoName = repo || config.repo;
    const repoBranch = branch || config.branch;
    const hubBasePath = basePath || config.basePath;

    const sshService = getSSHService(ip, username, password);
    
    if (!sshService.isConnected()) {
      await sshService.connect(ip, username, password);
    }

    // Set SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    try {
      // Step 1: Create directory
      res.write(`data: ${JSON.stringify({ type: 'step', step: 1, message: 'Creating directory...' })}\n\n`);
      const mkdirCmd = generateMkdirCommand(hubBasePath);
      await sshService.executeCommand(mkdirCmd);

      // Step 2: Detect download tool and download archive
      res.write(`data: ${JSON.stringify({ type: 'step', step: 2, message: 'Checking for download tools...' })}\n\n`);
      const downloadTool = await detectDownloadTool(sshService);
      
      if (!downloadTool) {
        throw new Error('Neither curl nor wget is available on the hub. Please install one of them.');
      }

      res.write(`data: ${JSON.stringify({ type: 'info', message: `Using ${downloadTool} for download...` })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: 'step', step: 2, message: 'Downloading repository...' })}\n\n`);
      const archiveUrl = getBranchArchiveUrl(repoOwner, repoName, repoBranch);
      const archivePath = `${hubBasePath}/repo.tar.gz`;
      const downloadCmd = generateDownloadCommand(archiveUrl, archivePath, downloadTool);

      await sshService.executeCommandWithStream(downloadCmd, {
        onStdout: (chunk) => {
          res.write(`data: ${JSON.stringify({ type: 'stdout', data: chunk })}\n\n`);
        },
        onStderr: (chunk) => {
          res.write(`data: ${JSON.stringify({ type: 'stderr', data: chunk })}\n\n`);
        },
      });

      // Verify download was successful
      const fileCheck = await sshService.executeCommand(`test -f "${archivePath}" && echo "exists"`).catch(() => ({ stdout: '' }));
      if (!fileCheck.stdout.includes('exists')) {
        throw new Error('Download failed - archive file not found after download');
      }

      // Step 3: Extract archive
      res.write(`data: ${JSON.stringify({ type: 'step', step: 3, message: 'Extracting archive...' })}\n\n`);
      const extractCmd = generateExtractCommand(archivePath, hubBasePath);
      await sshService.executeCommandWithStream(extractCmd, {
        onStdout: (chunk) => {
          res.write(`data: ${JSON.stringify({ type: 'stdout', data: chunk })}\n\n`);
        },
        onStderr: (chunk) => {
          res.write(`data: ${JSON.stringify({ type: 'stderr', data: chunk })}\n\n`);
        },
      });

      // Step 4: Install dependencies
      res.write(`data: ${JSON.stringify({ type: 'step', step: 4, message: 'Installing dependencies...' })}\n\n`);
      // Find the extracted directory (usually repo-branch format)
      const extractedDir = `${hubBasePath}/${repoName}-${repoBranch}`;
      
      // Check if package.json exists and install dependencies
      const packageJsonCheck = await sshService.executeCommand(`test -f "${extractedDir}/package.json" && echo "exists"`).catch(() => ({ stdout: '' }));
      
      if (packageJsonCheck.stdout.includes('exists')) {
        res.write(`data: ${JSON.stringify({ type: 'info', message: 'Found package.json, installing dependencies...' })}\n\n`);
        const installCmd = `cd "${extractedDir}" && npm install`;
        
        await sshService.executeCommandWithStream(installCmd, {
          onStdout: (chunk) => {
            res.write(`data: ${JSON.stringify({ type: 'stdout', data: chunk })}\n\n`);
          },
          onStderr: (chunk) => {
            res.write(`data: ${JSON.stringify({ type: 'stderr', data: chunk })}\n\n`);
          },
        });
        res.write(`data: ${JSON.stringify({ type: 'info', message: 'Dependencies installed successfully' })}\n\n`);
      } else {
        res.write(`data: ${JSON.stringify({ type: 'info', message: 'No package.json found, skipping dependency installation' })}\n\n`);
      }

      // Step 5: Run hub-setup.js
      res.write(`data: ${JSON.stringify({ type: 'step', step: 5, message: 'Running hub-setup.js...' })}\n\n`);
      const setupScriptPath = `${extractedDir}/hub-setup.js`;
      const runCmd = `cd "${extractedDir}" && node hub-setup.js`;

      await sshService.executeCommandWithStream(runCmd, {
        onStdout: (chunk) => {
          res.write(`data: ${JSON.stringify({ type: 'stdout', data: chunk })}\n\n`);
        },
        onStderr: (chunk) => {
          res.write(`data: ${JSON.stringify({ type: 'stderr', data: chunk })}\n\n`);
        },
      });

      res.write(`data: ${JSON.stringify({ type: 'success', message: 'Setup completed successfully!' })}\n\n`);
      res.end();
    } catch (error) {
      res.write(`data: ${JSON.stringify({ type: 'error', error: error.message })}\n\n`);
      res.end();
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/ssh/disconnect - Disconnect from hub
 */
app.post('/api/ssh/disconnect', async (req, res) => {
  try {
    const { ip, username } = req.body;

    if (!ip || !username) {
      return res.status(400).json({ error: 'IP and username are required' });
    }

    const key = `${ip}:${username}`;
    if (activeConnections.has(key)) {
      const sshService = activeConnections.get(key);
      await sshService.disconnect();
      activeConnections.delete(key);
    }

    res.json({ success: true, message: 'Disconnected successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});

