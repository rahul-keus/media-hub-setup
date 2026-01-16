// Application state
let currentConnection = null;

// DOM elements
const elements = {
  hubIp: document.getElementById('hub-ip'),
  btnSetup: document.getElementById('btn-setup'),
  connectionStatus: document.getElementById('connection-status'),
  logOutput: document.getElementById('log-output'),
  btnClearLog: document.getElementById('btn-clear-log'),
};

// API base URL
const API_BASE = window.location.origin;

// Default credentials
const DEFAULT_USERNAME = 'root';
const DEFAULT_PASSWORD = 'root';

// Logging functions
function addLog(message, type = 'stdout') {
  const logEntry = document.createElement('div');
  logEntry.className = `log-entry log-${type}`;
  logEntry.textContent = message;
  elements.logOutput.appendChild(logEntry);
  elements.logOutput.scrollTop = elements.logOutput.scrollHeight;
}

function clearLog() {
  elements.logOutput.innerHTML = '';
}

function updateStatus(message, className) {
  elements.connectionStatus.textContent = message;
  elements.connectionStatus.className = `status-indicator ${className}`;
  elements.connectionStatus.style.display = 'block';
}

function handleStreamData(data) {
  switch (data.type) {
    case 'connected':
      addLog(data.message, 'info');
      break;
    case 'stdout':
      addLog(data.data, 'stdout');
      break;
    case 'stderr':
      addLog(data.data, 'stderr');
      break;
    case 'info':
      addLog(data.message, 'info');
      break;
    case 'success':
      addLog(`✓ ${data.message}`, 'success');
      break;
    case 'error':
      addLog(`✗ Error: ${data.error}`, 'error');
      break;
    case 'step':
      addLog(`Step ${data.step}: ${data.message}`, 'step');
      break;
    case 'done':
      addLog('Command completed', 'success');
      break;
  }
}

async function handleStreamResponse(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    const chunk = decoder.decode(value);
    const lines = chunk.split('\n');

    for (const line of lines) {
      if (line.startsWith('data: ')) {
        try {
          const data = JSON.parse(line.slice(6));
          handleStreamData(data);
        } catch (e) {
          // Ignore parse errors
        }
      }
    }
  }
}

async function runSetup() {
  const ip = elements.hubIp.value.trim();

  if (!ip) {
    alert('Please enter Hub IP Address');
    return;
  }

  // Set connection info with defaults
  currentConnection = {
    ip,
    username: DEFAULT_USERNAME,
    password: DEFAULT_PASSWORD,
  };

  // Disable button during setup
  elements.btnSetup.disabled = true;
  updateStatus('Starting setup...', 'connecting');
  clearLog();
  addLog('Starting hub setup...', 'info');
  addLog(`Connecting to ${ip}...`, 'info');

  try {
    const response = await fetch(`${API_BASE}/api/setup/download-and-run`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        ip: currentConnection.ip,
        username: currentConnection.username,
        password: currentConnection.password,
        // Use default GitHub repo
        owner: 'rahul-keus',
        repo: 'media-hub-setup',
        branch: 'main',
      }),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ error: 'Setup failed' }));
      throw new Error(errorData.error || 'Setup failed');
    }

    await handleStreamResponse(response);
    updateStatus('Setup completed', 'connected');
  } catch (error) {
    addLog(`✗ Setup error: ${error.message}`, 'error');
    updateStatus('Setup failed', 'disconnected');
  } finally {
    elements.btnSetup.disabled = false;
  }
}

// Event listeners
elements.btnSetup.addEventListener('click', runSetup);
elements.btnClearLog.addEventListener('click', clearLog);

// Allow Enter key to trigger setup
elements.hubIp.addEventListener('keypress', (e) => {
  if (e.key === 'Enter' && !elements.btnSetup.disabled) {
    runSetup();
  }
});

// Initialize UI
addLog('Hub Setup UI ready. Enter Hub IP Address and click "Run Setup".', 'info');
