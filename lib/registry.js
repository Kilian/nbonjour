'use strict';

const timers = require("timers")
const dnsEqual = require('dns-equal');
const flatten = require('array-flatten');
const Service = require('./service');

const REANNOUNCE_MAX_MS = 60 * 60 * 1000;
const REANNOUNCE_FACTOR = 3;

module.exports = Registry;

function Registry(server) {
	this._server = server;
	this._services = []
}

Registry.prototype.publish = function (opts) {
	const service = new Service(opts);
	service.start = start.bind(service, this);
	service.stop = stop.bind(service, this);
	service.start({probe: opts.probe !== false});
	return service
};

Registry.prototype.unpublishAll = function (cb) {
	teardown(this._server, this._services, cb);
	this._services = []
};

Registry.prototype.destroy = function () {
	this._services.forEach(function (service) {
		service._destroyed = true
	})
};

function start(registry, opts) {
	if (this._activated) return;
	this._activated = true;

	if (!this._originalName) {
		this._originalName = this.name;
		this._nameAttempt = 1;
	}

	registry._services.push(this);
	registry._server.mdns.on('error', function (err) {
		service.emit('error', err)
	});

	if (opts.probe) {
		const service = this;
		probe(registry._server.mdns, this, function (exists) {
			if (exists) {
				/**
				 * If a service name is already in use on the network, the new
				 * service must select a different name. To do this, the new
				 * service MUST follow the algorithm described in RFC 6762
				 * Section 9, "Conflict Resolution" at
				 * https://datatracker.ietf.org/doc/html/rfc6762#section-9
				 * to pick a new name, and then repeat the entire service
				 * registration process.
				 *
				 */
				service._activated = false;
				const index = registry._services.indexOf(service);
				if (index !== -1) registry._services.splice(index, 1);

				service._nameAttempt++;
				service.name =
					service._originalName + " (" + service._nameAttempt + ")";
				service.fqdn = service.name + "." + service.type;
				console.log('Name conflict, retrying with "' + service.name + '"');

				// Try again with the new name
				service.start(registry, opts);
				return;
			}
			announce(registry._server, service)
		})
	} else {
		announce(registry._server, this)
	}
}

function stop(registry, cb) {
	if (!this._activated) return; // TODO: What about the callback?

	teardown(registry._server, this, cb);

	const index = registry._services.indexOf(this);
	if (index !== -1) registry._services.splice(index, 1)
}

/**
 * Check if a service name is already in use on the network.
 *
 * Used before announcing the new service.
 *
 * To guard against race conditions where multiple services are started
 * simultaneously on the network, wait a random amount of time (between
 * 0 and 250 ms) before probing.
 *
 * TODO: Add support for Simultaneous Probe Tiebreaking:
 * https://tools.ietf.org/html/rfc6762#section-8.2
 */
function probe(mdns, service, cb) {
	let sent = false;
	let retries = 0;
	let timer;

	mdns.on('response', onresponse);
	timers.setTimeout(send, Math.random() * 250);

	function send() {
		// abort if the service have or is being stopped in the meantime
		if (!service._activated || service._destroyed) return;

		mdns.query(service.fqdn, 'ANY', function () {
			// This function will optionally be called with an error object. We'll
			// just silently ignore it and retry as we normally would
			sent = true;
			timer = timers.setTimeout(++retries < 3 ? send : done, 250);
			timer.unref()
		})
	}

	function onresponse(packet) {
		// Apparently conflicting Multicast DNS responses received *before*
		// the first probe packet is sent MUST be silently ignored (see
		// discussion of stale probe packets in RFC 6762 Section 8.2,
		// "Simultaneous Probe Tiebreaking" at
		// https://tools.ietf.org/html/rfc6762#section-8.2
		if (!sent) return;

		if (packet.answers.some(matchRR) || packet.additionals.some(matchRR)) done(true)
	}

	function matchRR(rr) {
		return dnsEqual(rr.name, service.fqdn)
	}

	function done(exists) {
		mdns.removeListener('response', onresponse);
		timers.clearTimeout(timer);
		cb(Boolean(exists))
	}
}

/**
 * Initial service announcement
 *
 * Used to announce new services when they are first registered.
 *
 * Broadcasts right away, then after 3 seconds, 9 seconds, 27 seconds,
 * and so on, up to a maximum interval of one hour.
 */
function announce(server, service) {
	let delay = 1000;
	const packet = service._records();

	server.register(packet)

	;(function broadcast() {
		// abort if the service have or is being stopped in the meantime
		if (!service._activated || service._destroyed) return;

		server.mdns.respond(packet, function () {
			// This function will optionally be called with an error object. We'll
			// just silently ignore it and retry as we normally would
			if (!service.published) {
				service._activated = true;
				service.published = true;
				service.emit('up')
			}
			delay = delay * REANNOUNCE_FACTOR;
			if (delay < REANNOUNCE_MAX_MS && !service._destroyed) {
				timers.setTimeout(broadcast, delay).unref()
			}
		})
	})()
}

/**
 * Stop the given services
 *
 * Besides removing a service from the mDNS registry, a "goodbye"
 * message is sent for each service to let the network know about the
 * shutdown.
 */
function teardown(server, services, cb) {
	if (!Array.isArray(services)) services = [services];

	services = services.filter(function (service) {
		return service._activated // ignore services not currently starting or started
	});

	const records = flatten.depth(services.map(function (service) {
		service._activated = false;
		const records = service._records();
		records.forEach(function (record) {
			record.ttl = 0 // prepare goodbye message
		});
		return records
	}), 1);

	if (records.length === 0) return cb && cb();

	server.unregister(records);

	// send goodbye message
	server.mdns.respond(records, function () {
		services.forEach(function (service) {
			service.published = false
		});
		if (cb) cb.apply(null, arguments)
	})
}
