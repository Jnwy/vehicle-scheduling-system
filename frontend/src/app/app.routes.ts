import { Routes } from '@angular/router';

import { BlockConfigurationComponent } from './block-configuration.component';
import { ScheduleEditorComponent } from './schedule-editor.component';
import { ScheduleViewerComponent } from './schedule-viewer.component';

export const routes: Routes = [
  { path: '', redirectTo: 'editor', pathMatch: 'full' },
  { path: 'editor', component: ScheduleEditorComponent, data: { title: 'Schedule Editor' } },
  { path: 'schedule', component: ScheduleViewerComponent, data: { title: 'Schedule Viewer' } },
  { path: 'blocks', component: BlockConfigurationComponent, data: { title: 'Block Configuration' } },
  { path: '**', redirectTo: 'editor' },
];
