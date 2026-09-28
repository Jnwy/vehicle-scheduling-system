import { Component } from '@angular/core';

@Component({
  selector: 'app-root',
  standalone: true,
  template: `
    <main>
      <h1>Vehicle Scheduling System</h1>
      <p>Backend and frontend skeletons are running.</p>
    </main>
  `,
  styles: [
    `
      :host {
        display: block;
        min-height: 100vh;
        font-family: Arial, sans-serif;
        color: #1f2937;
        background: #f8fafc;
      }

      main {
        max-width: 720px;
        padding: 48px 24px;
        margin: 0 auto;
      }

      h1 {
        margin: 0 0 12px;
        font-size: 32px;
        font-weight: 700;
      }

      p {
        margin: 0;
        font-size: 18px;
      }
    `,
  ],
})
export class AppComponent {}
