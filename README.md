# homebridge-ness-d16x
[![npm](https://img.shields.io/npm/v/homebridge-ness-d16x)](https://www.npmjs.com/package/homebridge-ness-d16x) 
[![CircleCI](https://circleci.com/gh/anekol/homebridge-ness-d16x/tree/main.svg?style=shield)](https://circleci.com/gh/anekol/homebridge-ness-d16x/tree/main)
[![codecov](https://codecov.io/gh/anekol/homebridge-ness-d16x/branch/main/graph/badge.svg)](https://codecov.io/gh/anekol/homebridge-ness-d16x)
[![verified-by-homebridge](https://badgen.net/badge/homebridge/verified/purple)](https://github.com/homebridge/homebridge/wiki/Verified-Plugins)

A Homebridge plugin to support the Ness D8x / D16x Security Panel and zone accessories.

* Home mode (Ness Home/Monitor Mode) may not be configured on your panel. If Ness Home/Monitor Mode is not configured on your panel and you don't exclude mode "Home", be aware that selecting Away followed by Home will not disarm the panel (Night or Off will).

* Night mode is not supported by the Ness D8x/D16x, but is provided as a no-op for use in Homekit rules.

* Outputs are modelled as simulated read-only "Outlets".

<a href="readme/panel.png"><img src="readme/panel.png" alt="panel" width="100"/></a>
<a href="readme/outputs.png"><img src="readme/outputs.png" alt="panel" width="100"/></a>

## Installation

### Hardware Interface
Requires an interface that supports [Ness D8x / D16x Serial Interface ASCII protocol](http://www.nesscorporation.com/Software/Ness_D8-D16_ASCII_protocol_rev13.pdf) eg.

* [Usriot USR-TCP232-302](https://www.pusr.com/download/M0/USR-TCP232-302-User-Manual_V1.0.3.01.pdf)
* [Ness IP232](http://nesscorporation.com/101-244.html)
### Homebridge
Use the Homebridge UI homebridge-config-ui-x UI Plugins/Config or from the shell.
```sh
$ npm install homebridge-ness-d16x --save
```

## Support and Issues
* For support requests please use the [homebridge-ness-d16x](https://forums.whirlpool.net.au/thread/3jm6pwkq) thread at Whirlpool.

* Please use the Issues tracker only for:
  * Bug reports
  * Submitting pull requests
    
A bug is either a _demonstrable problem_ that is caused by the code in the repository,
or missing, unclear, or misleading documentation. Good bug reports are very 
welcome - thank you!

