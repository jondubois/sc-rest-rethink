var _ = require('lodash');

var AccessControl = function (scServer, thinky, options) {
  // Setup SocketCluster middleware for access control
  var self = this;

  this.options = options || {};
  this.schema = this.options.schema || {};
  this.thinky = thinky;

  this._getModelAccessRightsFilter = function (type, direction) {
    var modelSchema = self.schema[type];
    if (!modelSchema) {
      return null;
    }
    var modelAuthorization = modelSchema.accessControl;
    if (!modelAuthorization) {
      return null;
    }
    return modelAuthorization[direction] || null;
  };

  scServer.addMiddleware(scServer.MIDDLEWARE_EMIT, function (req, next) {
    if (req.event == 'create' || req.event == 'read' || req.event == 'update' || req.event == 'delete') {
      // If socket has a valid auth token, then allow emitting get or set events
      var authToken = req.socket.getAuthToken();

      var accessFilter = self._getModelAccessRightsFilter(req.data.type, 'inbound');
      if (accessFilter) {
        var crudRequest = {
          r: self.thinky.r,
          socket: req.socket,
          action: req.event,
          authToken: authToken,
          query: req.data
        };
        accessFilter(crudRequest, function (isAllowed) {
          if (isAllowed) {
            next();
          } else {
            var crudBlockedError = new Error('You are not permitted to perform a CRUD operation on the ' + req.data.type + ' resource with ID ' + req.data.id);
            crudBlockedError.name = 'CRUDBlockedError';
            next(crudBlockedError);
          }
        });
      } else {
        if (self.options.blockInboundByDefault) {
          var crudBlockedError = new Error('You are not permitted to perform a CRUD operation on the ' + req.data.type + ' resource with ID ' + req.data.id + ' - No access control rules found');
          crudBlockedError.name = 'CRUDBlockedError';
          next(crudBlockedError);
        } else {
          next();
        }
      }
    } else {
      // This module is only responsible for CRUD-related access control.
      next();
    }
  });

  var channelViewPredicateRegex = /^([^\(]*)\((.*)\):([^:]*)$/;

  var getChannelResourceQuery = function (channelName) {
    var mainParts = channelName.split('>');
    if (mainParts[0] == 'crud' && mainParts[1]) {
      var resourceString = mainParts[1];

      if (resourceString.indexOf(':') != -1) {
        // If resource is a view.
        var viewMatches = resourceString.match(channelViewPredicateRegex);
        var viewResource = {
          view: viewMatches[1],
          type: viewMatches[3]
        }
        try {
          viewResource.predicateData = JSON.parse(viewMatches[2]);
        } catch (e) {}

        return viewResource;
      } else {
        // If resource is a simple model.
        var resourceParts = resourceString.split('/');
        var modelResource = {
          type: resourceParts[0]
        };
        if (resourceParts[1]) {
          modelResource.id = resourceParts[1];
        }
        if (resourceParts[2]) {
          modelResource.field = resourceParts[2];
        }
        return modelResource;
      }
    }
    return null;
  };

  scServer.addMiddleware(scServer.MIDDLEWARE_PUBLISH_IN, function (req, next) {
    var channelResourceQuery = getChannelResourceQuery(req.channel);
    if (channelResourceQuery) {
      // Always block CRUD publish from outside clients.
      var crudPublishNotAllowedError = new Error('Cannot publish to a CRUD resource channel');
      crudPublishNotAllowedError.name = 'CRUDPublishNotAllowedError';
      next(crudPublishNotAllowedError);
    } else {
      next();
    }
  });

  scServer.addMiddleware(scServer.MIDDLEWARE_PUBLISH_OUT, function (req, next) {
    var authToken = req.socket.getAuthToken();
    var channelResourceQuery = getChannelResourceQuery(req.channel);
    if (!channelResourceQuery) {
      next();
      return;
    }
    var accessFilter = self._getModelAccessRightsFilter(channelResourceQuery.type, 'outbound');
    if (accessFilter) {
      var publishOutResponse = {
        r: self.thinky.r,
        socket: req.socket,
        action: 'publish',
        authToken: authToken,
        query: channelResourceQuery,
        resource: req.data
      };
      accessFilter(publishOutResponse, function (isAllowed) {
        if (isAllowed) {
          next();
        } else {
          var crudBlockedError = new Error('Cannot publish out to ' + req.channel + ' channel');
          crudBlockedError.name = 'CRUDBlockedError';
          next(crudBlockedError);
        }
      });
    } else {
      if (self.options.blockOutboundByDefault) {
        var crudBlockedError = new Error('Cannot publish out to ' + req.channel + ' channel - No access control rules found');
        crudBlockedError.name = 'CRUDBlockedError';
        next(crudBlockedError);
      } else {
        next();
      }
    }
  });

  scServer.addMiddleware(scServer.MIDDLEWARE_SUBSCRIBE, function (req, next) {
    var authToken = req.socket.getAuthToken();
    var channelResourceQuery = getChannelResourceQuery(req.channel);
    if (!channelResourceQuery) {
      next();
      return;
    }
    var accessFilter = self._getModelAccessRightsFilter(channelResourceQuery.type, 'inbound');
    if (accessFilter) {
      if (req.allowCrudAccess) {
        next();
      } else {
        var subscribeRequest = {
          r: self.thinky.r,
          socket: req.socket,
          action: 'subscribe',
          authToken: authToken,
          query: channelResourceQuery
        };
        accessFilter(subscribeRequest, function (isAllowed) {
          if (isAllowed) {
            next();
          } else {
            var crudBlockedError = new Error('Cannot subscribe to ' + req.channel + ' channel');
            crudBlockedError.name = 'CRUDBlockedError';
            next(crudBlockedError);
          }
        });
      }
    } else {
      if (self.options.blockInboundByDefault) {
        var crudBlockedError = new Error('Cannot subscribe to ' + req.channel + ' channel - No access control rules found');
        crudBlockedError.name = 'CRUDBlockedError';
        next(crudBlockedError);
      } else {
        next();
      }
    }
  });
};

AccessControl.prototype.filterOutboundRead = function (res, next) {
  var accessFilter = this._getModelAccessRightsFilter(res.query.type, 'outbound');
  if (accessFilter) {
    accessFilter(res, function (isAllowed) {
      if (isAllowed) {
        next();
      } else {
        var crudBlockedError = new Error('You are not permitted to perform a CRUD read operation on the ' + req.query.type + ' resource with ID ' + req.query.id);
        crudBlockedError.name = 'CRUDBlockedError';
        next(crudBlockedError);
      }
    });
  } else {
    if (this.options.blockOutboundByDefault) {
      var crudBlockedError = new Error('You are not permitted to perform a CRUD read operation on the ' + res.query.type + ' resource with ID ' + res.query.id + ' - No access control rules found');
      crudBlockedError.name = 'CRUDBlockedError';
      next(crudBlockedError);
    } else {
      next();
    }
  }
};

module.exports = AccessControl;