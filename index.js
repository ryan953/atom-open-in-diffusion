'use babel';

const CONFIG_DEFAULT_HOST = 'https://phabricator.example.com/api/';
const CONFIG_DEFAULT_TOKEN = 'api-XYZ';

function rangeToString(range) {
  if (range.start.row === range.end.row) {
    return range.start.row + 1;
  } else {
    return (range.start.row + 1) + '-' + (range.end.row + 1);
  }
}

function simplifyProjectName(name) {
  return (name || '').trim().toLowerCase().replace(/[\s\-\_\(\)]/g, '');
}

export default {
  subscriptions: null,
  canduit: null,
  foundProjects: {},

  config: {
    'conduit-host': {
      title: 'Optional: Conduit API endpoint',
      description: 'URL to the phabricator instance API, usually ends with `/api/`',
      type: 'string',
      default: CONFIG_DEFAULT_HOST,
    },
    'conduit-token': {
      title: 'Optional: Conduit API Token',
      description: 'Get a Standard API Token from https://phabricator.example.com/settings and clicking on "Conduit API Tokens".',
      type: 'string',
      default: CONFIG_DEFAULT_TOKEN,
    },
  },

  activate(state) {
    this.subscriptions = new (require('atom').CompositeDisposable)();

    this.subscriptions.add(
      atom.config.onDidChange('open-in-diffusion.conduit-host', () => {
        this.connectToConduit();
      })
    );

    this.subscriptions.add(
      atom.config.onDidChange('open-in-diffusion.conduit-token', () => {
        this.connectToConduit();
      })
    );

    this.subscriptions.add(atom.commands.add('atom-workspace', {
      'open-in-diffusion:clear-project-cache': () => {
        this.foundProjects = {};
      },
      'open-in-diffusion:open-in-phabricator': () => {
        const editor = atom.workspace.getActiveTextEditor();
        if (!editor) {
          return;
        }

        this.openInDiffusion(
          editor.getPath(),
          editor.getSelectedBufferRanges()
        );
      },
    }));

    this.connectToConduit();
  },

  deactivate() {
    this.subscriptions.dispose();
  },

  serialize() {
    return {};
  },

  conduitConfig() {
    const host = atom.config.get('open-in-diffusion.conduit-host');
    const token = atom.config.get('open-in-diffusion.conduit-token');
    if (host === CONFIG_DEFAULT_HOST || token === CONFIG_DEFAULT_TOKEN) {
      return {};
    } else {
      return {api: host, token: token};
    }
  },

  conduitFactory() {
    return new Promise((resolve, reject) => {
      const Canduit = require('canduit');
      new Canduit(this.conduitConfig(), (err, canduit) => {
        if (err) {
          reject(err);
        }
        resolve(canduit);
      });
    });
  },

  connectToConduit() {
    this.canduit = null;
    this.conduitFactory()
      .then((canduit) => {
        this.canduit = canduit;
        console.info(`Connected to diffusion.`);
      });
  },

  genRepositorySearch(search) {
    return this.genExecPhabricatorQuery('diffusion.repository.search', {
      queryKey: ['active'],
      constraints: {
        query: search,
      },
    });
  },

  genExecPhabricatorQuery(endpoint, options) {
    return new Promise((resolve, reject) => {
      if (!this.canduit) {
        reject('Not yet connected to canduit');
      }
      this.canduit.exec(endpoint, options, (err, response) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(response);
      });
    });
  },

  genFindPhabProject(projectPath) {
    const searchTerm = require('path').basename(projectPath);

    if (this.foundProjects[projectPath]) {
      return Promise.resolve(this.foundProjects[projectPath]);
    } else {
      return this.genRepositorySearch(searchTerm)
        .then((response) => {
          this.foundProjects[projectPath] = this.getMatchingPhabProject(response.data, searchTerm);
          return this.foundProjects[projectPath];
        });
    }
  },

  getMatchingPhabProject(data, searchTerm) {
    const simpleSearchTerm = simplifyProjectName(searchTerm);

    const names = data.map((data) => {
      if (!data.fields) {
        return null;
      }
      return {
        name: simplifyProjectName(data.fields.name),
        shortName: simplifyProjectName(data.fields.shortName),
        callsign: simplifyProjectName(data.fields.callsign),
        project: data,
      };
    }).filter(Boolean);

    const nameMatches = names.filter((item) => item.name === simpleSearchTerm);
    if (nameMatches.length) {
      return nameMatches.shift().project;
    }
    const shortNameMatches = names.filter((item) => item.shortName === simpleSearchTerm);
    if (shortNameMatches.length) {
      return shortNameMatches.shift().project;
    }
    const callSignMatches = names.filter((item) => item.callsign === simpleSearchTerm);
    if (callSignMatches.length) {
      return callSignMatches.shift().project;
    }

    throw Error(`No project found matching ${searchTerm}`);
  },

  getProjectPath(filePath) {
    return atom.project.getPaths()
      .filter((path) => filePath.startsWith(path))
      .shift();
  },

  openInDiffusion(nuclideFilePath, selectedRanges) {
    const projectPath = this.getProjectPath(nuclideFilePath);
    const relativeFilePath = nuclideFilePath.replace(projectPath, '');

    const range = '$' + selectedRanges
      .map(rangeToString)
      .join(',');

    this.genFindPhabProject(projectPath)
      .then((project) => {
        const id = project.fields.callsign
          ? project.fields.callsign
          : project.id;

        require('opn')(`https://phabricator.pinadmin.com/diffusion/${id}/browse/master${relativeFilePath}${range}`);
      })
      .catch((message) => {
        console.warn(`Unable to open ${nuclideFilePath}. ${message}`);
      });
  },

};
