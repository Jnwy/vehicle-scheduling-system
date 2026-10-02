import { Component, inject, signal } from '@angular/core';
import { Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';

@Component({
  selector: 'app-root',
  imports: [RouterLink, RouterLinkActive, RouterOutlet],
  template: `
    <main>
      <header class="page-header">
        <div>
          <p class="eyebrow">Vehicle Scheduling System</p>
          <h1>{{ pageTitle() }}</h1>
        </div>
      </header>
      <nav class="page-nav" aria-label="Application pages">
        <a routerLink="/editor" routerLinkActive="active" ariaCurrentWhenActive="page">Schedule Editor</a>
        <a routerLink="/schedule" routerLinkActive="active" ariaCurrentWhenActive="page">Schedule Viewer</a>
        <a routerLink="/blocks" routerLinkActive="active" ariaCurrentWhenActive="page">Block Configuration</a>
      </nav>
      <router-outlet (activate)="onPageActivated()" />
    </main>
  `,
  styleUrl: './scheduling-page.css',
})
export class AppComponent {
  private readonly router = inject(Router);
  readonly pageTitle = signal('Vehicle Scheduling System');

  onPageActivated(): void {
    this.pageTitle.set(this.router.routerState.snapshot.root.firstChild?.data['title'] ?? 'Vehicle Scheduling System');
  }
}
