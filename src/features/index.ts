// Feature modules register their tool panels and commands here.
import { initPrintTools } from './print';
import { initCutTools } from './cut';
import { initCaps } from './caps';
import { initBatch } from './batch';
import { initPaletteAndMenu } from './palette';
import { initViews } from './views';
import { initLook } from './look';
import { initTurntable } from './turntable';
import { initCompare } from './compare';
import { initBuild } from './build';
import { initAssets } from './assets';
import { initPrepare } from './prepare';
import { initReport } from './report';
import { initPieces } from './pieces';

export function initFeatures() {
  initPrintTools();
  initCutTools();
  initCaps();
  initBatch();
  initPaletteAndMenu();
  initViews();
  initLook();
  initTurntable();
  initCompare();
  initBuild();
  initAssets();
  initPrepare();
  initReport();
  initPieces();
}
