/* ESM loader：把 @capacitor/* 重定向到本地 mock，使手机端依赖 Capacitor 的模块可在 Node 里跑通。
 * 用法：node --experimental-loader ./mock-loader.mjs integration-test.js
 */
import { pathToFileURL } from 'node:url';

const MOCKS = {
  '@capacitor/filesystem': './mock-capacitor-filesystem.mjs',
};

export async function resolve(specifier, context, next) {
  if (MOCKS[specifier]) {
    const url = new URL(MOCKS[specifier], import.meta.url).href;
    return { url, shortCircuit: true };
  }
  return next(specifier, context);
}
