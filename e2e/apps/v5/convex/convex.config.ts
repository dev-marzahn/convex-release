import migrations from '@convex-dev/migrations/convex.config';
import { defineApp } from 'convex/server';
import predeployFixture from 'predeploy-fixture/convex.config';

const app = defineApp();
app.use(migrations);
app.use(predeployFixture);
export default app;
