'use babel';

const CONFIG_DEFAULT_HOST = 'https://phabricator.example.com/api/';
const CONFIG_DEFAULT_TOKEN = 'api-XYZ';
const CONNECTING_MESSAGE = 'Checking connection to Diffusion...';

function rangeToString(range) {
  if (range.start.row === range.end.row) {
    return range.start.row + 1;
  } else {
    return (range.start.row + 1) + '-' + (range.end.row + 1);
  }
}

function simplifyProjectName(name) {
  return (name || '').trim().toLowerCase().replace(/[\s\-_()]/g, '');
}

function requireApiUrl(url) {
  // remove first so we don't double-add it if it's already there
  return removeApiFromUrl(url) + '/api/';
}

function removeApiFromUrl(url) {
  return url.replace(/\/api?\/$/, '');
}

let _phabHost = null;

function getDiffusionHost() {
  const host = removeApiFromUrl(atom.config.get('open-in-diffusion.conduit-host'));
  if (host !== CONFIG_DEFAULT_HOST) {
    return Promise.resolve(removeApiFromUrl(host));
  }

  if (_phabHost) {
    return _phabHost;
  }

  return new Promise((resolve, reject) => {
    const arcrc = path.join(process.env.HOME, '.arcrc');
    require('fs').readFile(arcrc, function (err, data) {
      if (err) {
        reject(err);
      };

      try {
        const config = JSON.parse(data);
        _phabHost = removeApiFromUrl(Object.keys(config.hosts)[0]);
        resolve(_phabHost);
      } catch (e) {
        reject(e);
      }
    });
  });
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

  activate() {
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

  consumeSignal(registry) {
    this.provider = registry.create();
    this.subscriptions.add(this.provider)
  },

  deactivate() {
    this.subscriptions.dispose();
  },

  serialize() {
    return {};
  },

  conduitConfig() {
    const host = requireApiUrl(atom.config.get('open-in-diffusion.conduit-host'));
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
    this.provider && this.provider.add(CONNECTING_MESSAGE);
    this.canduit = null;
    this.conduitFactory()
      .then((canduit) => {
        this.canduit = canduit;
        console.info(`[open-in-diffusion] Successfully connected to diffusion.`);
        this.provider && this.provider.remove(CONNECTING_MESSAGE);
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
    this.provider && this.provider.add(CONNECTING_MESSAGE);

    const projectPath = this.getProjectPath(nuclideFilePath);
    const relativeFilePath = nuclideFilePath.replace(projectPath, '');

    const range = '$' + selectedRanges
      .map(rangeToString)
      .join(',');

    Promise.all([
      getDiffusionHost(),
      this.genFindPhabProject(projectPath)
    ]).then((host, project) => {
        const id = project.fields.callsign
          ? project.fields.callsign
          : project.id;

        require('opn')(`${host}/diffusion/${id}/browse/master${relativeFilePath}${range}`);
        this.provider && this.provider.remove(CONNECTING_MESSAGE);
      })
      .catch((message) => {
        console.warn(`[open-in-diffusion] Unable to open ${nuclideFilePath}. ${message}`);
        this.provider && this.provider.remove(CONNECTING_MESSAGE);
        const errorMessage = `Unable to open ${nuclideFilePath}`;
        this.provider && this.provider.add(errorMessage);
        setTimeout(() => {
          this.provider && this.provider.remove(errorMessage);
        }, 2000);
      });
  },

};
