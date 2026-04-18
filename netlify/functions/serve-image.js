const fs = require('fs');
const path = require('path');

let mappingCache = null;
function getMapping() {
  if (mappingCache) return mappingCache;
  try {
    const file = path.join(__dirname, '../../scripts/image-url-mapping.json');
    if (fs.existsSync(file)) {
      mappingCache = JSON.parse(fs.readFileSync(file, 'utf8'));
      return mappingCache;
    }
  } catch (e) {}
  return {};
}

exports.handler = async (event) => {
  const headers = { 'Access-Control-Allow-Origin': '*' };
  const key = event.queryStringParameters?.key;
  if (!key) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'key required' }) };
  }

  const mapping = getMapping();
  const url = mapping[key];
  if (url) {
    return { statusCode: 302, headers: { ...headers, Location: url }, body: '' };
  }
  return { statusCode: 404, headers, body: JSON.stringify({ error: 'not found' }) };
};
