"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = HomepageFeatures;
var clsx_1 = require("clsx");
var Heading_1 = require("@theme/Heading");
var styles_module_css_1 = require("./styles.module.css");
var FeatureList = [
    {
        title: 'AI-Powered Resolution',
        description: (<>
        ProPR uses Claude AI to automatically analyze and resolve GitHub issues,
        providing intelligent solutions to your repository's problems.
      </>),
    },
    {
        title: 'Automated Workflows',
        description: (<>
        Seamlessly integrates with GitHub to monitor issues, create branches,
        and submit pull requests automatically.
      </>),
    },
    {
        title: 'Scalable Architecture',
        description: (<>
        Built with Docker, Redis, and PostgreSQL for reliable, distributed
        processing of multiple repositories and tasks.
      </>),
    },
];
function Feature(_a) {
    var title = _a.title, description = _a.description;
    return (<div className={(0, clsx_1.default)('col col--4')}>
      <div className="text--center padding-horiz--md">
        <Heading_1.default as="h3">{title}</Heading_1.default>
        <p>{description}</p>
      </div>
    </div>);
}
function HomepageFeatures() {
    return (<section className={styles_module_css_1.default.features}>
      <div className="container">
        <div className="row">
          {FeatureList.map(function (props, idx) { return (<Feature key={idx} {...props}/>); })}
        </div>
      </div>
    </section>);
}
