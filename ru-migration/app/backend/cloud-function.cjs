'use strict';

exports.handler = async (event, context) => {
  const module = await import('./yandex-function.mjs');
  return module.handler(event, context);
};
