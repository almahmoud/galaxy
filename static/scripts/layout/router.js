var jQuery=require("jquery"),$=jQuery,QUERY_STRING=require("utils/query-string-parsing"),Ui=require("mvc/ui/ui-misc"),Router=Backbone.Router.extend({initialize:function(a,b){this.page=a,this.options=b},push:function(a,b){b=b||{},b.__identifer=Math.random().toString(36).substr(2),$.isEmptyObject(b)||(a+=-1==a.indexOf("?")?"?":"&",a+=$.param(b,!0)),Galaxy.params=b,this.navigate(a,{trigger:!0})},execute:function(a,b,c){Galaxy.debug("router execute:",a,b,c);var d=QUERY_STRING.parse(b.pop());b.push(d),a&&(this.authenticate(b,c)?a.apply(this,b):this.access_denied())},authenticate:function(){return!0},access_denied:function(){this.page.display(new Ui.Message({status:"danger",message:"You must be logged in with proper credentials to make this request.",persistent:!0}))}});module.exports=Router;
//# sourceMappingURL=../../maps/layout/router.js.map