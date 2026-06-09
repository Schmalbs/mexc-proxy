const corsAnywhere = require('cors-anywhere');

const host = '0.0.0.0';
const port = process.env.PORT || 8080;

corsAnywhere.createServer({
  originWhitelist: [],          // allow all origins
  requireHeader: [],
  removeHeaders: ['cookie', 'cookie2'],
  redirectSameOrigin: true,
  httpProxyOptions: {
    xfwd: false,
  },
}).listen(port, host, () => {
  console.log(`CORS proxy running on ${host}:${port}`);
});
