export type {
  StaticMatrixArray,
  StaticMatrixObject,
  DynamicMatrixFn,
  DynamicMatrixContext,
  Matrix,
  MatrixInclude,
  MatrixExclude,
  MatrixValues,
} from './types.js';

export { isStaticArray, isStaticObject, isDynamicFunction } from './types.js';

export { expandMatrix, applyIncludeExclude } from './expand.js';
