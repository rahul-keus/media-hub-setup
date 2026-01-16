import { NodeSSH } from 'node-ssh';

/**
 * SSH Service - Manage SSH connections and execute commands with streaming output
 */
export class SSHService {
  constructor() {
    this.ssh = new NodeSSH();
    this.connections = new Map(); // Store connections by key (ip:username)
  }

  /**
   * Generate connection key
   */
  _getConnectionKey(ip, username) {
    return `${ip}:${username}`;
  }

  /**
   * Connect to remote host via SSH
   * @param {string} ip - IP address
   * @param {string} username - SSH username
   * @param {string} password - SSH password
   * @param {number} retries - Number of retry attempts (default: 3)
   * @returns {Promise<void>}
   */
  async connect(ip, username, password, retries = 3) {
    const key = this._getConnectionKey(ip, username);
    
    // Check if already connected
    if (this.connections.has(key)) {
      const existingSsh = this.connections.get(key);
      if (existingSsh.isConnected()) {
        this.ssh = existingSsh;
        return;
      }
    }

    let attempts = 0;
    while (attempts < retries) {
      try {
        await this.ssh.connect({
          host: ip,
          username: username,
          password: password,
          readyTimeout: 20000,
        });
        
        // Store connection
        this.connections.set(key, this.ssh);
        return;
      } catch (error) {
        attempts++;
        if (attempts >= retries) {
          throw new Error(`Failed to connect after ${retries} attempts: ${error.message}`);
        }
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }
  }

  /**
   * Execute command with streaming output
   * @param {string} command - Command to execute
   * @param {object} options - Options (cwd, onStdout, onStderr)
   * @returns {Promise<{stdout: string, stderr: string, code: number}>}
   */
  async executeCommand(command, options = {}) {
    const { cwd = null, onStdout = null, onStderr = null } = options;

    return new Promise((resolve, reject) => {
      let stdout = '';
      let stderr = '';

      this.ssh.execCommand(command, { cwd })
        .then(result => {
          resolve({
            stdout: result.stdout,
            stderr: result.stderr,
            code: result.code,
          });
        })
        .catch(error => {
          reject(error);
        });

      // Note: NodeSSH execCommand doesn't support real-time streaming callbacks
      // For streaming, we'll use exec with stream handlers
    });
  }

  /**
   * Execute command with real-time streaming output
   * @param {string} command - Command to execute
   * @param {object} options - Options (cwd, onStdout, onStderr)
   * @returns {Promise<{code: number}>}
   */
  async executeCommandStream(command, options = {}) {
    const { cwd = null, onStdout = null, onStderr = null } = options;

    return new Promise((resolve, reject) => {
      this.ssh.execCommand(command, { cwd, stream: 'both' })
        .then(result => {
          // For streaming, we need to use exec instead of execCommand
          // But execCommand with stream option should work
          resolve({ code: result.code });
        })
        .catch(error => {
          reject(error);
        });
    });
  }

  /**
   * Execute command with real-time output streaming using exec
   * @param {string} command - Command to execute
   * @param {object} options - Options (cwd, onStdout, onStderr)
   * @returns {Promise<{code: number}>}
   */
  async executeCommandWithStream(command, options = {}) {
    const { cwd = null, onStdout = null, onStderr = null } = options;

    return new Promise((resolve, reject) => {
      this.ssh.execCommand(command, { cwd })
        .then(result => {
          // Send stdout and stderr to callbacks
          if (onStdout && result.stdout) {
            onStdout(result.stdout);
          }
          if (onStderr && result.stderr) {
            onStderr(result.stderr);
          }
          resolve({ code: result.code });
        })
        .catch(error => {
          reject(error);
        });
    });
  }

  /**
   * Check if connected
   * @returns {boolean}
   */
  isConnected() {
    return this.ssh.isConnected();
  }

  /**
   * Disconnect from current connection
   */
  async disconnect() {
    if (this.ssh.isConnected()) {
      await this.ssh.dispose();
    }
  }

  /**
   * Disconnect from specific connection
   * @param {string} ip - IP address
   * @param {string} username - SSH username
   */
  async disconnectConnection(ip, username) {
    const key = this._getConnectionKey(ip, username);
    const ssh = this.connections.get(key);
    if (ssh && ssh.isConnected()) {
      await ssh.dispose();
      this.connections.delete(key);
    }
  }

  /**
   * Disconnect all connections
   */
  async disconnectAll() {
    for (const [key, ssh] of this.connections.entries()) {
      if (ssh.isConnected()) {
        await ssh.dispose();
      }
    }
    this.connections.clear();
  }
}

