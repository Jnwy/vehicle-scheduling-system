import { bootstrapApplication } from '@angular/platform-browser';
import { provideHttpClient } from '@angular/common/http';
import { provideRouter, withViewTransitions } from '@angular/router';

import { AppComponent } from './app/app.component';
import { routes } from './app/app.routes';

bootstrapApplication(AppComponent, {
  providers: [
    provideHttpClient(),
    // Cross-fades between pages using the browser View Transitions API;
    // browsers without it navigate instantly.
    provideRouter(routes, withViewTransitions({
      onViewTransitionCreated: ({ transition }) => {
        if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
          transition.skipTransition();
        }
      },
    })),
  ],
}).catch((error) => console.error(error));
