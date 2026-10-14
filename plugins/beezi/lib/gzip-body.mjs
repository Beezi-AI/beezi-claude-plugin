import zlib from 'zlib';

// gzip a JSON value off the main thread; resolves a Buffer.
export function gzipJson(value) {
  return new Promise((resolve, reject) => {
    zlib.gzip(Buffer.from(JSON.stringify(value), 'utf-8'), (error, compressed) => {
      if (error) reject(error);
      else resolve(compressed);
    });
  });
}
