'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const {inventory} = require('./terminal/cloud-inventory.cjs');

test('selected cloud inventories import addresses and display names without provider credentials', () => {
  const aws = inventory('aws',{Reservations:[{Instances:[
    {InstanceId:'i-a',Tags:[{Key:'Name',Value:'Build'}],PublicDnsName:'build.example.test',Placement:{AvailabilityZone:'us-east-1a'}},
    {InstanceId:'i-b',PrivateIpAddress:'10.10.0.11'},{InstanceId:'i-offline'},
  ]}]});
  assert.equal(aws.hosts[0].name,'Build');
  assert.equal(aws.hosts[0].group,'AWS/us-east-1a');
  assert.equal(aws.hosts[1].host,'10.10.0.11');
  assert.equal(aws.skipped,1);
  const azure = inventory('azure',[{name:'a',resourceGroup:'rg',publicIps:'203.0.113.8, 203.0.113.9',privateIps:'10.0.0.3',credential:'discard'}]);
  assert.deepEqual(azure.hosts,[{name:'a',host:'203.0.113.8',group:'Azure/rg',user:'',port:null}]);
  const digital = inventory('digitalocean',[{name:'d',region:{slug:'nyc3'},networks:{v4:[{type:'private',ip_address:'10.0.0.1'},{type:'public',ip_address:'203.0.113.2'}]}}]);
  assert.equal(digital.hosts[0].host,'203.0.113.2');
  assert.throws(() => inventory('other',[]));
  assert.throws(() => inventory('azure',Array(2049).fill({})));
});
