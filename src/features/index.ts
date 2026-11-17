// Feature modules register their tool panels and commands here.
import { initPrintTools } from './print';
import { initCutTools } from './cut';
import { initCaps } from './caps';
import { initBatch } from './batch';
import { initPaletteAndMenu } from './palette';
import { initViews } from './views';

export function initFeatures() {
  initPrintTools();
  initCutTools();
  initCaps();
  initBatch();
  initPaletteAndMenu();
  initViews();
}
