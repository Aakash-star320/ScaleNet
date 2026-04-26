const axios = require('axios');

async function train() {
  try {
    const res = await axios.post('http://localhost:3001/ml/train');
    console.log('✅ Model trained successfully!');
    console.log(res.data);
  } catch (err) {
    console.error('❌ Failed to train model:', err.response?.data?.error || err.message);
  }
}

train();
