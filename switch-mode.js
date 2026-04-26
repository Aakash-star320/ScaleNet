const axios = require('axios');

const mode = process.argv[2] || 'ml'; // defaults to ml

async function switchMode() {
  try {
    const res = await axios.post('http://localhost:3001/ml/switch', { mode });
    console.log(`✅ Switched successfully to: ${mode}`);
    console.log(res.data);
  } catch (err) {
    console.error(`❌ Failed to switch to ${mode}:`, err.response?.data?.error || err.message);
  }
}

switchMode();
